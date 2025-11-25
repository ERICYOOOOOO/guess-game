require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. 连接数据库 ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB 连接成功"))
    .catch(err => console.error("❌ MongoDB 连接失败:", err));

// --- 2. 定义模型 ---
// 用户表：存名字和分数
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    score: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// 竞猜表：存当前轮的猜测
const GuessSchema = new mongoose.Schema({
    username: String,
    guess: String
});
const Guess = mongoose.model('Guess', GuessSchema);

// 系统状态表
const SystemSchema = new mongoose.Schema({
    id: { type: String, default: '1' },
    roundOpen: { type: Boolean, default: true }
});
const System = mongoose.model('System', SystemSchema);

// 初始化系统状态
async function initSystem() {
    try {
        await System.updateOne({ id: '1' }, { $setOnInsert: { roundOpen: true } }, { upsert: true });
    } catch (e) {
        console.error("初始化系统状态失败", e);
    }
}
initSystem();

// --- 3. 中间件 ---
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static('public'));

// --- 4. 路由逻辑 ---

// 获取状态 (排行榜核心逻辑)
app.get('/api/status', async (req, res) => {
    try {
        const username = req.cookies.username;
        
        // 关键调试：打印一下现在数据库里到底有几个人
        const allUsers = await User.find().sort({ score: -1 });
        if (allUsers.length === 0) {
            console.log("⚠️ 警告：当前数据库的用户表是空的！(User collection is empty)");
        }

        const sys = await System.findOne({ id: '1' });
        const myGuessReq = username ? await Guess.findOne({ username }) : null;
        const currentUserReq = username ? await User.findOne({ username }) : null;

        res.json({
            isLoggedIn: !!username,
            currentUser: username || null,
            myScore: currentUserReq ? currentUserReq.score : 0,
            myGuess: myGuessReq ? myGuessReq.guess : null,
            roundOpen: sys ? sys.roundOpen : true,
            // 映射数据给前端
            leaderboard: allUsers.map(u => ({ name: u.username, score: u.score }))
        });
    } catch (e) {
        console.error("获取状态出错:", e);
        res.status(500).json({ error: "服务器错误" });
    }
});

// 用户登录 (修复：确保用户一定被创建)
app.post('/api/login', async (req, res) => {
    try {
        // 去除空格，保证名字干净
        const rawName = req.body.username;
        if (!rawName) return res.status(400).send('名字不能为空');
        const username = rawName.trim();

        console.log(`👤 用户尝试登录: [${username}]`);

        // 使用 findOneAndUpdate + upsert: true
        // 如果用户不存在就创建，存在就什么都不改，返回这个用户文档
        await User.findOneAndUpdate(
            { username: username },
            { $setOnInsert: { score: 0 } }, // 只有新建时才设为0，老用户保持原分
            { upsert: true, new: true }
        );

        res.cookie('username', username, { maxAge: 90000000 });
        res.json({ success: true });
    } catch (e) {
        console.error("登录出错:", e);
        res.status(500).send("登录失败");
    }
});

// 提交竞猜 (修复版：自动补全缺失的用户档案)
app.post('/api/guess', async (req, res) => {
    try {
        const username = req.cookies.username;
        const guess = req.body.guess ? req.body.guess.trim() : "";
        
        if (!username) return res.status(401).send('请先登录');

        const sys = await System.findOne({ id: '1' });
        if (!sys || !sys.roundOpen) return res.status(403).send('本轮已截止');

        console.log(`📝 用户 [${username}] 提交竞猜: ${guess}`);

        // --- 核心修复开始: 检查并自动创建用户 ---
        // 既然他能提交竞猜，说明他有 Cookie。如果数据库里没他，说明是“漏网之鱼”，我们给他补上。
        const userExists = await User.findOne({ username });
        if (!userExists) {
            console.log(`💡 检测到 [${username}] 是幽灵用户（有Cookie无档案），正在自动创建档案...`);
            await User.create({ username, score: 0 });
        }
        // --- 核心修复结束 ---

        // 更新竞猜记录
        await Guess.findOneAndUpdate(
            { username }, 
            { guess }, 
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        console.error("竞猜出错:", e);
        res.status(500).send("提交失败");
    }
});

// 管理员结算 (修复：增强日志和匹配逻辑)
app.post('/api/admin/settle', async (req, res) => {
    try {
        const rawAnswer = req.body.correctAnswer || "";
        // 统一转大写，去空格
        const correctAnswer = rawAnswer.trim().toUpperCase();

        console.log("--------------------------------");
        console.log(`📢 开始结算，正确答案是: "${correctAnswer}"`);

        // 1. 找出所有猜测记录
        const allGuesses = await Guess.find();
        const winners = [];

        for (const g of allGuesses) {
            // 用户的猜测也转大写比较
            const userGuess = (g.guess || "").trim().toUpperCase();
            
            if (userGuess === correctAnswer) {
                winners.push(g.username);
            }
        }

        console.log(`🎉 猜对名单 (${winners.length}人):`, winners);

        // 2. 更新分数
        if (winners.length > 0) {
            // 使用 updateMany 批量更新
            const result = await User.updateMany(
                { username: { $in: winners } }, // 查找所有在赢家列表里的名字
                { $inc: { score: 10 } }         // 分数 +10
            );
            console.log(`✅ 数据库更新报告: 匹配到了 ${result.matchedCount} 个用户，修改了 ${result.modifiedCount} 个。`);
            
            if (result.matchedCount === 0) {
                console.error("❌ 严重错误: 找到了赢家，但在 User 表里没找到这些人！可能是 User 表是空的？");
            }
        } else {
            console.log("⚠️ 本轮无人猜对。");
        }

        // 3. 清理本轮
        await Guess.deleteMany({});
        await System.updateOne({ id: '1' }, { roundOpen: true });

        res.json({ success: true, winners });

    } catch (e) {
        console.error("结算出错:", e);
        res.status(500).send("结算失败");
    }
});

// 启动
app.listen(PORT, () => {
    console.log(`✅ 服务器运行在端口 ${PORT}`);
});