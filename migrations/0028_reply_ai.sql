-- 답장 AI 해석 결과(담당자용 한 줄, 예: "AI: 참석(2번 일정) · 22일 10시 선택"). 보관 기간이 지나면 다른 개인정보와 함께 지운다.
ALTER TABLE candidates ADD COLUMN ai_note TEXT NOT NULL DEFAULT '';
