/* ============================================================
   storage.js
   localStorage ラッパ + 設定 / 記録 / マスタキャッシュの管理
   ============================================================ */

const Storage = (() => {
  const KEYS = {
    CONFIG: "pk.config.v1",          // { owner, repo, branch, token }
    RECORDS: "pk.records.v1",        // { records: [...], sha: "..." }
    MASTER_CACHE: "pk.master.v1",    // master.json キャッシュ
    PENDING: "pk.pending.v1",        // 未同期の記録ID配列
  };

  const DEFAULT_CONFIG = {
    owner: "",
    repo: "",
    branch: "main",
    token: "",
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn("storage read fail", key, e);
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("storage write fail", key, e);
      return false;
    }
  }

  return {
    // --- config ---
    getConfig() {
      return { ...DEFAULT_CONFIG, ...read(KEYS.CONFIG, {}) };
    },
    setConfig(cfg) {
      write(KEYS.CONFIG, cfg);
    },
    hasGitHubConfig() {
      const c = this.getConfig();
      return !!(c.owner && c.repo && c.token);
    },

    // --- records (ローカルキャッシュ) ---
    getRecords() {
      const data = read(KEYS.RECORDS, { records: [], sha: null });
      return data;
    },
    setRecords(records, sha) {
      write(KEYS.RECORDS, { records, sha: sha || null });
    },
    addRecord(record) {
      const data = this.getRecords();
      data.records = data.records || [];
      // 同じIDがあれば置き換え、なければ追加
      const idx = data.records.findIndex((r) => r.id === record.id);
      if (idx >= 0) data.records[idx] = record;
      else data.records.push(record);
      write(KEYS.RECORDS, data);
    },
    deleteRecord(recordId) {
      const data = this.getRecords();
      data.records = (data.records || []).filter((r) => r.id !== recordId);
      write(KEYS.RECORDS, data);
    },
    clearRecords() {
      write(KEYS.RECORDS, { records: [], sha: null });
      write(KEYS.PENDING, []);
    },

    // --- master cache ---
    getMasterCache() {
      return read(KEYS.MASTER_CACHE, null);
    },
    setMasterCache(master) {
      write(KEYS.MASTER_CACHE, master);
    },

    // --- pending (未同期記録ID一覧) ---
    getPending() {
      return read(KEYS.PENDING, []);
    },
    addPending(recordId) {
      const p = this.getPending();
      if (!p.includes(recordId)) p.push(recordId);
      write(KEYS.PENDING, p);
    },
    clearPending() {
      write(KEYS.PENDING, []);
    },
    hasPending() {
      return this.getPending().length > 0;
    },
  };
})();
