-- 지원자 별점: 담당자마다 한 사람에게 1~5점 하나(다시 주면 바뀜). 평균·개수는 목록·추천 순서에 쓴다.
CREATE TABLE IF NOT EXISTS applicant_ratings (
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (applicant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_applicant ON applicant_ratings(applicant_id);
