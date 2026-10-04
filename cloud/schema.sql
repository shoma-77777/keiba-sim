-- 競走馬データベース（SQLite）
PRAGMA foreign_keys = ON;

-- 競走馬マスタ
CREATE TABLE IF NOT EXISTS horses (
  horse_id    TEXT PRIMARY KEY,          -- netkeiba 馬ID（10桁）
  name        TEXT NOT NULL,
  sex         TEXT,                      -- 牡/牝/セ
  birth_year  INTEGER,
  sire        TEXT,                      -- 父
  dam         TEXT,                      -- 母
  damsire     TEXT,                      -- 母父
  trainer     TEXT,
  updated_at  TEXT
);

-- 過去成績（1走1行）
CREATE TABLE IF NOT EXISTS runs (
  horse_id    TEXT NOT NULL REFERENCES horses(horse_id),
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  venue       TEXT,                      -- 東京 / 京都 / 海外名など
  race_name   TEXT,
  race_id     TEXT,
  surface     TEXT,                      -- 芝 / ダ / 障
  distance    INTEGER,
  going       TEXT,                      -- 良 / 稍 / 重 / 不
  field_size  INTEGER,
  gate        INTEGER,                   -- 馬番
  odds        REAL,
  popularity  INTEGER,
  finish      INTEGER,                   -- 着順（中止等は NULL）
  jockey      TEXT,
  weight_carried REAL,                   -- 斤量
  time        TEXT,
  margin      TEXT,                      -- 着差
  passing     TEXT,                      -- 通過順 "3-3-2-1"
  pace        TEXT,                      -- 前後半3F "35.1-34.2"
  last3f      REAL,                      -- 上がり3F
  body_weight TEXT,                      -- 馬体重 "480(+4)"
  PRIMARY KEY (horse_id, date, race_name)
);

-- 開催レース（番組）
CREATE TABLE IF NOT EXISTS races (
  race_id     TEXT PRIMARY KEY,          -- 12桁 YYYY+場+回+日+R
  date        TEXT NOT NULL,
  venue       TEXT NOT NULL,
  race_no     INTEGER NOT NULL,
  name        TEXT,
  surface     TEXT,
  distance    INTEGER,
  direction   TEXT,                      -- 右 / 左 / 直
  going       TEXT,
  weather     TEXT,
  post_time   TEXT,
  field_size  INTEGER,
  updated_at  TEXT
);

-- 出馬表
CREATE TABLE IF NOT EXISTS entries (
  race_id     TEXT NOT NULL REFERENCES races(race_id),
  num         INTEGER NOT NULL,          -- 馬番
  waku        INTEGER,                   -- 枠番
  horse_id    TEXT,
  name        TEXT,
  sex_age     TEXT,
  weight      REAL,                      -- 斤量
  jockey      TEXT,
  trainer     TEXT,
  odds        REAL,
  popularity  INTEGER,
  PRIMARY KEY (race_id, num)
);

-- 調教（追い切り）
CREATE TABLE IF NOT EXISTS training (
  race_id     TEXT NOT NULL,
  num         INTEGER NOT NULL,
  horse_id    TEXT,
  grade       TEXT,                      -- A/B/C/D
  comment     TEXT,                      -- 短評
  score       INTEGER,                   -- アプリ用 0-100（A=75, B=60, C=45, D=35）
  PRIMARY KEY (race_id, num)
);

-- 派生指標（アプリ側でも再計算できるが、分析用に保存）
CREATE VIEW IF NOT EXISTS horse_aptitude AS
SELECT h.horse_id, h.name,
  COUNT(r.date)                                            AS starts,
  SUM(r.finish = 1)                                        AS wins,
  ROUND(AVG(CASE WHEN r.surface='芝' THEN 1.0 - (r.finish-1.0)/(r.field_size-1) END), 3) AS turf_score,
  ROUND(AVG(CASE WHEN r.surface='ダ' THEN 1.0 - (r.finish-1.0)/(r.field_size-1) END), 3) AS dirt_score,
  ROUND(AVG(CASE WHEN r.going IN ('稍','重','不') THEN 1.0 - (r.finish-1.0)/(r.field_size-1) END), 3) AS wet_score,
  ROUND(SUM(r.distance * (1.0 - (r.finish-1.0)/(r.field_size-1))) / NULLIF(SUM(1.0 - (r.finish-1.0)/(r.field_size-1)),0)) AS dist_center,
  ROUND(AVG(r.last3f), 2)                                  AS avg_last3f
FROM horses h LEFT JOIN runs r ON r.horse_id = h.horse_id AND r.field_size > 1 AND r.finish IS NOT NULL
GROUP BY h.horse_id;
