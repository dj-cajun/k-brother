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

// 💡 스크린샷의 최상위 빈 폴더 라인과 1:1로 정확하게 매칭!
const VAULT = __dirname; 

client.once('ready', () => console.log(`Hermes 5-Star Elite Edition Online: ${client.user.tag}`));

// 🛡️ AI 오류 발생 시 즉시 우회하는 3단계 백업 자동 스위치
async function callAIWithBackup(msg, stepName, primaryModel, systemPrompt, userContent) {
    try {
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: primaryModel,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }]
        }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } });
        return res.data.choices[0].message.content;
    } catch (err1) {
        console.error(`[주력군 실패] ${stepName}: ${err1.message}`);
        await msg.reply(`⚠️ [백업 가동] ${stepName} 엔진 마비 ➡️ 2순위 GLM-5.2 엔진으로 교체합니다.`);
        
        try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: 'zhipu/glm-5.2', 
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }]
            }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } });
            return res.data.choices[0].message.content;
        } catch (err2) {
            console.error(`[예비군 실패] ${stepName}: ${err2.message}`);
            await msg.reply(`🚨 [비상 보루 가동] 오픈라우터 통신 장애 ➡️ 3순위 구글 Gemini 다이렉트 망을 기동합니다.`);
            
            try {
                const qa = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: `System: ${systemPrompt}\n\nUser: ${userContent}`
                });
                return qa.text;
            } catch (err3) {
                throw new Error(`[공장 가동 불가] 모든 AI 서버의 백업라인이 응답하지 않습니다: ${err3.message}`);
            }
        }
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith('!hermes')) return;
    const prompt = msg.content.replace('!hermes', '').trim();
    const ts = Date.now();
    
    try {
        // 1. 기획자 (PM) 부서
        await msg.reply('[1/5] 기획자(PM) 비즈니스 기능 요구사항 명세 시작...');
        const pmPrompt = "You are an elite Product Manager. Create a professional, detailed Business Functional Specification Document in markdown. Output in Korean.";
        const pmDoc = await callAIWithBackup(msg, "기획자(PM)", "anthropic/claude-4.8-opus", pmPrompt, prompt);
        fs.writeFileSync(path.join(VAULT, '01-Blueprints', `01-PM-${ts}.md`), pmDoc);

        // 2. 관리자 (CTO) 부서
        await msg.reply('[2/5] 관리자(CTO) 시스템 아키텍처 및 DB 설계 시작...');
        const ctoPrompt = "You are a visionary CTO. Based on the PM's specification, design a detailed system architecture, database schema, and API route map in markdown. Output in Korean.";
        const ctoDoc = await callAIWithBackup(msg, "관리자(CTO)", "anthropic/claude-4.8-opus", ctoPrompt, `Original Goal: ${prompt}\n\nPM Spec:\n${pmDoc}`);
        fs.writeFileSync(path.join(VAULT, '01-Blueprints', `02-CTO-${ts}.md`), ctoDoc);

        // 3. 디자인 (UI/UX) 부서
        await msg.reply('[3/5] 디자인(UI/UX) 유저 인터페이스 및 화면 흐름 설계 시작...');
        const uiPrompt = "You are a Lead UI/UX Designer. Define complete user interface flows, layout structures, and visual interactions for the screens in markdown. Output in Korean.";
        const uiDoc = await callAIWithBackup(msg, "디자인(UI/UX)", "anthropic/claude-4.8-opus", uiPrompt, `Original Goal: ${prompt}\n\nCTO Specs:\n${ctoDoc}`);
        fs.writeFileSync(path.join(VAULT, '01-Blueprints', `03-UI-${ts}.md`), uiDoc);

        // 4. 코더 (Coder) 부서 ➡️ 딥시크 전담 배정
        await msg.reply('[4/5] 코더(Developer) 프로덕션 소스코드 자율 구현 가동 (DeepSeek)...');
        const coderPrompt = "You are a Senior Full-Stack Developer. Output ONLY complete, production-ready, fully executable JavaScript/Node.js code matching all previous specifications. No explanations, no chat, no markdown wrapper except codeblocks.";
        const codeDoc = await callAIWithBackup(msg, "코더(Developer)", "deepseek/deepseek-chat", coderPrompt, `CTO Spec:\n${ctoDoc}\n\nUI/UX Flow:\n${uiDoc}`);
        fs.writeFileSync(path.join(VAULT, '02-Workspace', `impl-${ts}.js`), codeDoc);

        // 5. 점검 (QA Engineer) 부서 
        await msg.reply('[5/5] 점검(QA) 코드 버그 및 보안 취약점 감사 시작...');
        const qaPrompt = "You are an Expert QA Engineer and Security Auditor. Review the following code for syntax errors, logical bugs, and security flaws. Output a thorough inspection report in Korean.";
        const qaDoc = await callAIWithBackup(msg, "점검(QA)", "deepseek/deepseek-chat", qaPrompt, codeDoc);
        fs.writeFileSync(path.join(VAULT, '03-Logs', `qa-${ts}.md`), qaDoc);

        // 디스코드 실시간 실황 중계
        if (process.env.DISCORD_WEBHOOK_URL) {
            await axios.post(process.env.DISCORD_WEBHOOK_URL, {
                content: `### 🦅 **[Hermes 5대 천왕 무인 공장 가동 완공]**\n• 기획서: 01-PM-${ts}.md\n• 아키텍처: 02-CTO-${ts}.md\n• UI명세: 03-UI-${ts}.md\n• 소스코드: impl-${ts}.js\n• 검증로그: qa-${ts}.md\n⚡ 대표님 맥북 옵시디언 대시보드로 즉시 전송되었습니다!`
            });
        }
        
        // 깃허브 창고로 화물 트럭 출발
        require('child_process').exec(`cd ${VAULT} && git add . && git commit -m "Hermes 5-Star Run ${ts}" && git push origin main`);
        await msg.reply('🎉 [Hermes 5-Star Task Completed] All blueprints and scripts successfully deployed!');
    } catch (err) {
        console.error(err);
        await msg.reply(`🚨 공장 라인 비상 정지 에러: ${err.message}`);
    }
});
client.login(process.env.DISCORD_TOKEN);
