const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const prompt = process.argv[2];
if (!prompt) {
  console.error("❌ 명령어를 입력해주세요. 예: node agent.js 'PayOS 라우터 코드 짜줘'");
  process.exit(1);
}

// 2026년 오픈라우터에서 가장 확실하게 작동하는 탑티어 코딩 모델 리스트
const modelQueue = [
  'openai/gpt-4o',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
  'anthropic/claude-3.5-sonnet:beta'
];

async function run() {
  let success = false;

  for (const model of modelQueue) {
    console.log(`🚀 에이전트 예비 두뇌 [${model}] 가동 및 설계 요청 중...`);
    try {
      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: model,
        messages: [
          {
            role: 'system',
            content: 'You are a world-class full-stack developer agent. Based on the user request, you must output a strict JSON object containing the files to create/modify and an optional verification command. Do NOT include any markdown code blocks, formatting, or conversational text. Output ONLY the raw JSON string.\n\nFormat:\n{"files": [{"path": "relative/path/to/file.ts", "content": "exact file content code here"}], "command": "npm run build"}'
          },
          { role: 'user', content: prompt }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30초 타임아웃
      });

      const reply = response.data.choices[0].message.content.trim();
      const jsonStr = reply.replace(/^```json/, '').replace(/```$/, '').trim();
      const data = JSON.parse(jsonStr);

      console.log("🛠️ 설계도 수신 완료. 코드를 서버 파일 시스템에 물리적 작성 중...");
      for (const file of data.files) {
        const fullPath = path.resolve(file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf8');
        console.log(`✅ 작성 및 갱신 완료: ${file.path}`);
      }

      if (data.command) {
        console.log(`🏃 코드 안전성 검증 명령 실행 중: ${data.command}`);
        try {
          execSync(data.command, { stdio: 'inherit' });
          console.log("🎉 빌드 검증 성공! 오류 없는 무결점 코드가 확인되었습니다.");
        } catch (e) {
          console.error("⚠️ 빌드 중 에러가 발견되었습니다. 수정 루프가 필요합니다.");
        }
      }

      success = true;
      break; // 성공 시 루프 종료
    } catch (error) {
      console.log(`⚠️ [${model}] 가동 실패(또는 404). 즉시 다음 예비 두뇌로 전향합니다...`);
    }
  }

  if (!success) {
    console.error("❌ 모든 예비 두뇌 가동에 실패했습니다. .env 파일의 API 키 상태나 오픈라우터 충전 잔액을 다시 한번 확인해 주세요.");
  }
}
run();
