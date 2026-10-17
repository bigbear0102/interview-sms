-- AI 기능 추가(2026-10-17): 일정 변경 희망 일시·질문 답장 초안(담당자가 확인 후 보냄), 일반 문자 분류, 공고별 원가중심점 추천
ALTER TABLE candidates ADD COLUMN ai_wanted TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN ai_draft TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound ADD COLUMN ai_note TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ai_postings (
  recruit_no TEXT PRIMARY KEY,
  cost_center TEXT NOT NULL DEFAULT '',   -- 원가중심점 목록(cost_centers)에 있는 이름만
  job TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
