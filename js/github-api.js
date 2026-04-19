/* ============================================================
   github-api.js
   GitHub Contents API で data/records.json を読み書きする
   ============================================================ */

const GitHubAPI = (() => {
  const RECORDS_PATH = "data/records.json";
  const API_BASE = "https://api.github.com";

  function cfg() {
    return Storage.getConfig();
  }

  function headers() {
    const c = cfg();
    const h = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (c.token) h.Authorization = `Bearer ${c.token}`;
    return h;
  }

  // UTF-8 -> base64 (日本語を含む文字列を安全にエンコード)
  function encodeB64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function decodeB64(b64) {
    const binary = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function apiUrl(path) {
    const c = cfg();
    return `${API_BASE}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${path}?ref=${encodeURIComponent(c.branch || "main")}`;
  }

  return {
    // 接続確認: ユーザー情報を取得できるか
    async testConnection() {
      const c = cfg();
      if (!c.owner || !c.repo || !c.token) {
        return { ok: false, message: "Owner/Repo/Tokenを入力してください" };
      }
      try {
        const resp = await fetch(`${API_BASE}/repos/${c.owner}/${c.repo}`, { headers: headers() });
        if (!resp.ok) {
          return { ok: false, message: `HTTP ${resp.status}: ${resp.statusText}` };
        }
        const data = await resp.json();
        return { ok: true, message: `接続OK (${data.full_name})` };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },

    // records.json を取得。存在しなければ { records: [], sha: null }
    async fetchRecords() {
      const c = cfg();
      if (!c.owner || !c.repo || !c.token) {
        throw new Error("GitHub未設定");
      }
      const resp = await fetch(apiUrl(RECORDS_PATH), { headers: headers() });
      if (resp.status === 404) {
        return { records: [], sha: null };
      }
      if (!resp.ok) {
        throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
      }
      const data = await resp.json();
      const content = decodeB64(data.content);
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error("records.json が壊れています");
      }
      return {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        sha: data.sha,
      };
    },

    // records.json を書き込む。shaが一致しないとコンフリクト
    async putRecords(records, currentSha) {
      const c = cfg();
      if (!c.owner || !c.repo || !c.token) {
        throw new Error("GitHub未設定");
      }
      const payload = {
        updated_at: new Date().toISOString(),
        records,
      };
      const body = {
        message: `Update records (${records.length} entries)`,
        content: encodeB64(JSON.stringify(payload, null, 2) + "\n"),
        branch: c.branch || "main",
      };
      if (currentSha) body.sha = currentSha;

      const resp = await fetch(apiUrl(RECORDS_PATH), {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub API ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      return { sha: data.content.sha };
    },
  };
})();
