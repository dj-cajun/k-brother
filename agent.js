const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 💡 대표님 맥북 옵시디언 족보에 맞춰 최상위 루트로 정렬
const VAULT = __dirname;

client.once('ready', () => console.log(`Hermes Online: ${client.user.tag}`));

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith('!hermes')) return;
    const prompt = msg.content.replace('!hermes', '').trim();
    const ts = Date.now();
    await msg.reply('[1/3] Claude PM 기획 중...');
    try {
        // 1단계: Claude 기획서 작성
        const bpRes = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'anthropic/claude-4.8-opus',
            messages: [
                { role: 'system', content: 'You are CTO. Write system architecture spec in markdown.' },
                { role: 'user', content: prompt }
            ]
        }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } });
        const bp = bpRes.data.choices[0].message.content;
        fs.writeFileSync(path.join(VAULT, '01-Blueprints', `bp-${ts}.md`), bp);
        
        // 2단계: 오픈라우터 딥시크(DeepSeek) 코딩 엔진
        await msg.reply('[2/3] OpenRouter DeepSeek 코딩 중...');

        const cdRes = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'deepseek/deepseek-chat',
            messages: [
                { role: 'system', content: 'You are Coder. Output ONLY complete executable source code. No chat.' },
                { role: 'user', content: `Blueprint:\n\n${bp}` }
            ]
        }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } });
        const code = cdRes.data.choices[0].message.content;
        fs.writeFileSync(path.join(VAULT, '02-Workspace', `impl-${ts}.js`), code);
        
        // 3단계: Gemini QA 검증
        await msg.reply('[3/3] Gemini QA 검증 및 싱크 트리거...');

        const qa = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Check errors in this code:\n\n${code}`
        });
        fs.writeFileSync(path.join(VAULT, '03-Logs', `qa-${ts}.md`), qa.text);

        if (process.env.DISCORD_WEBHOOK_URL) {
            await axios.post(process.env.DISCORD_WEBHOOK_URL, {
                content: `### 🦅 **[Hermes 자율 구동 완료]**\n• 설계도: bp-${ts}.md\n• 소스코드: impl-${ts}.js\n• QA로그: qa-${ts}.md\n⚡ 맥북 옵시디언 대시보드가 새로고침 되었습니다.`
            });
        }
        
        // 깃허브 창고로 즉시 자동 배송
        require('child_process').exec(`cd ${VAULT} && git add . && git commit -m "Hermes Run ${ts}" && git push origin main`);
        await msg.reply('🎉 [Hermes Task Completed] Dashboard synced!');
    } catch (err) {
        console.error(err);
        await msg.reply(`Error: ${err.message}`);
    }
});
client.login(process.env.DISCORD_TOKEN);
