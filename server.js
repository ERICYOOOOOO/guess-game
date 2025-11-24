const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// 中间件设置
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static('public')); // 让 public 文件夹里的网页能被访问

// --- 数据库辅助函数 ---
// 如果文件不存在，先创建一个空的
if (!fs.existsSync(DB_FILE)) {
    const initialData = { 
        users: {},      // 存用户分数: { "小明": { score: 0 } }
        guesses: {},    // 存当前轮竞猜: { "小明": "A" }
        roundOpen: true // 这一轮是否还在进行
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
}

function readDB() {
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- 路由逻辑 ---

// 1. 获取当前状态（前端一加载就调这个）
app.get('/api/status', (req, res) => {
    const db = readDB();
    const username = req.cookies.username;
    
    // 生成排行榜数组
    const leaderboard = Object.entries(db.users)
        .map(([name, data]) => ({ name, score: data.score }))
        .sort((a, b) => b.score - a.score);

    res.json({
        isLoggedIn: !!username,
        currentUser: username || null,
        myScore: username ? (db.users[username]?.score || 0) : 0,
        myGuess: username ? (db.guesses[username] || null) : null,
        roundOpen: db.roundOpen,
        leaderboard: leaderboard
    });
});

// 2. 用户登录
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).send('名字不能为空');

    const db = readDB();
    // 如果是新用户，初始化分数
    if (!db.users[username]) {
        db.users[username] = { score: 0 };
        writeDB(db);
    }

    // 设置 Cookie，保存用户状态
    res.cookie('username', username, { maxAge: 90000000 }); // 这里的 Cookie 会保存很久
    res.json({ success: true });
});

// 3. 用户提交竞猜
app.post('/api/guess', (req, res) => {
    const username = req.cookies.username;
    const { guess } = req.body;

    if (!username) return res.status(401).send('请先登录');
    
    const db = readDB();
    if (!db.roundOpen) return res.status(403).send('本轮竞猜已结束，等待管理员开启下一轮');

    // 记录竞猜
    db.guesses[username] = guess;
    writeDB(db);
    res.json({ success: true });
});

// 4. 管理员：结算并开启下一轮
app.post('/api/admin/settle', (req, res) => {
    const { correctAnswer } = req.body;
    const db = readDB();

    let winners = [];
    // 遍历所有人的竞猜，算分
    for (const [user, guess] of Object.entries(db.guesses)) {
        if (guess === correctAnswer) {
            if (db.users[user]) {
                db.users[user].score += 10; // 答对加10分
                winners.push(user);
            }
        }
    }

    // 清空当前轮的竞猜，准备下一轮
    db.guesses = {}; 
    db.roundOpen = true; // 保持开放，或者你可以设计成 false 等待手动开启
    writeDB(db);

    res.json({ success: true, winners });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`游戏服务器已启动！在浏览器访问: http://localhost:${PORT}`);
});