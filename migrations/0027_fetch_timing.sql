-- 연락처 가져오기 걸린 시간을 재기 위한 요청 시각(요청 → 확장이 가져감(fetch_at) → 결과(fetch_done_at))
ALTER TABLE applicant_inbox ADD COLUMN fetch_req_at INTEGER;
ALTER TABLE applicant_inbox ADD COLUMN fetch_done_at INTEGER;
