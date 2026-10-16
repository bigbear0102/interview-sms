-- 원가중심점 목록(수백 개). 수신함에서 여기 있는 것만 고르게 해 오타를 막는다. 목록이 비어 있으면 자유롭게 입력할 수 있다.
CREATE TABLE cost_centers (
  name TEXT PRIMARY KEY,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
