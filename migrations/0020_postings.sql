-- 공고별 정리: 지원 건에 알바몬 공고 정보를 따로 보관하고, "지원한 곳"은 원가중심점, "직무"는 직무 값만 담는다.
ALTER TABLE applicant_applications ADD COLUMN recruit_no TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_applications ADD COLUMN posting_title TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_applications ADD COLUMN company_raw TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_applications_recruit ON applicant_applications(recruit_no) WHERE recruit_no != '';
ALTER TABLE inbox_cost_rules ADD COLUMN job TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_inbox ADD COLUMN job TEXT NOT NULL DEFAULT '';

-- 이미 메일에서 등록된 지원 건 정리: 예전에는 "지원한 곳"에 알바몬 근무회사명, "직무"에 공고 제목이 그대로 들어갔다.
-- 원본은 posting_title / company_raw 로 옮겨 보존하고, 값이 원가중심점이 아니면 비워서 "정리 필요"로 보이게 한다.
UPDATE applicant_applications SET
  recruit_no = COALESCE((SELECT i.recruit_no FROM applicant_inbox i WHERE i.applicant_id = applicant_applications.applicant_id AND i.job_title = applicant_applications.job LIMIT 1), ''),
  company_raw = COALESCE((SELECT i.company FROM applicant_inbox i WHERE i.applicant_id = applicant_applications.applicant_id AND i.job_title = applicant_applications.job LIMIT 1), ''),
  posting_title = job,
  applied_to = CASE WHEN applied_to = (SELECT i.company FROM applicant_inbox i WHERE i.applicant_id = applicant_applications.applicant_id AND i.job_title = applicant_applications.job LIMIT 1) THEN '' ELSE applied_to END,
  job = ''
WHERE job != '' AND EXISTS (SELECT 1 FROM applicant_inbox i WHERE i.applicant_id = applicant_applications.applicant_id AND i.job_title = applicant_applications.job);
