-- 알바몬 이력서 전체 저장(확장 v1.9): 연락처만이 아니라 이력서 화면의 모든 내용을 남긴다.
-- text: 화면 글 전체(최대 6만 자), pairs: 항목·값 쌍, sections: 제목들, parsed: 시스템이 정리한 항목
CREATE TABLE IF NOT EXISTS applicant_resumes (
  inbox_id INTEGER PRIMARY KEY,
  apply_no TEXT NOT NULL DEFAULT '',
  page_url TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  pairs TEXT NOT NULL DEFAULT '[]',
  sections TEXT NOT NULL DEFAULT '[]',
  parsed TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL
);
-- 이미 연락처를 가져온(또는 등록한) 지원자의 이력서만 다시 읽는 요청(연락처 보기 버튼은 누르지 않는다)
ALTER TABLE applicant_inbox ADD COLUMN resume_only INTEGER NOT NULL DEFAULT 0;
-- 지원 알림 메일의 모든 항목(지금까지는 일부만 저장했다)
ALTER TABLE applicant_inbox ADD COLUMN mail_fields TEXT NOT NULL DEFAULT '';
