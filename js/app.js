/* ============================================================
   app.js — 利き酒手帖
   ============================================================ */

const App = (() => {
  // アプリの状態
  const state = {
    master: null,             // master.json
    records: [],              // [{ id, sake_id, rating, memo, drunk_at, store, photos? }]
    recordsSha: null,         // GitHub側のsha
    currentStoreId: null,     // 閲覧中の店舗
    currentSakeId: null,      // 詳細画面の対象
    editingRecordId: null,    // 詳細画面で編集中の記録ID (null=新規モード)
    filter: "all",            // all | unread | done | retired
    search: "",
    syncing: false,
  };

  // ============================================================
  // ユーティリティ
  // ============================================================

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function toast(msg, type = "ok") {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("error", type === "error");
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2400);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const y = d.getFullYear(); const m = d.getMonth() + 1; const day = d.getDate();
    return `${y}.${String(m).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
  }

  function nowLocalDatetimeValue() {
    // <input type="datetime-local"> 向けの文字列 (ローカルタイムゾーンのYYYY-MM-DDTHH:MM)
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function localDatetimeToISO(local) {
    // "YYYY-MM-DDTHH:MM" (ローカル) を ISO (タイムゾーン付) に
    const d = new Date(local);
    return d.toISOString();
  }

  function genId() {
    return `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function getStore(id) { return (state.master?.stores || []).find((s) => s.id === id); }
  function getSake(id) { return (state.master?.sake || []).find((s) => s.id === id); }

  function recordsFor(sakeId) {
    return state.records
      .filter((r) => r.sake_id === sakeId)
      .sort((a, b) => (b.drunk_at || "").localeCompare(a.drunk_at || ""));
  }

  function latestRecord(sakeId) {
    const rs = recordsFor(sakeId);
    return rs.length ? rs[0] : null;
  }

  function isDone(sakeId) {
    return recordsFor(sakeId).length > 0;
  }

  function sakesInStore(storeId, { includeRetired = false } = {}) {
    // 店舗に存在する銘柄を、その店舗での唎酒番号順に並べる。
    // 各行は { sake, number, retired } を持つ。
    // includeRetired=false のとき引退エントリは含めない。
    const master = state.master;
    if (!master) return [];
    const rows = [];
    for (const s of master.sake) {
      const here = s.available_at.find((a) => a.store === storeId);
      if (!here) continue;
      const retired = !!here.retired_at;
      if (retired && !includeRetired) continue;
      rows.push({ sake: s, number: here.number, retired, retiredAt: here.retired_at });
    }
    rows.sort((a, b) => {
      // 引退は後ろに送る
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      return a.number.localeCompare(b.number, "ja", { numeric: true });
    });
    return rows;
  }

  // 店舗で「過去に存在した」銘柄（現役 + 引退）を返す
  function sakesEverInStore(storeId) {
    return sakesInStore(storeId, { includeRetired: true });
  }

  // 全期間で存在した銘柄（available_atが1件でもある銘柄。現状すべて該当）
  function allSakes() {
    return state.master?.sake || [];
  }

  // 現役銘柄の総数（3店舗いずれかに現役エントリがある）
  function activeSakesCount() {
    return allSakes().filter((s) =>
      s.available_at.some((a) => !a.retired_at)
    ).length;
  }

  // ============================================================
  // ナビゲーション
  // ============================================================

  function showView(name) {
    $$(".view").forEach((v) => v.toggleAttribute("hidden", v.dataset.view !== name));
    const back = $(".header-back");
    back.toggleAttribute("hidden", name === "home");
    // ヘッダーサブタイトル
    const sub = $("#header-sub");
    if (name === "home") sub.textContent = "ぽんしゅ館";
    else if (name === "settings") sub.textContent = "設定";
    else if (name === "store") sub.textContent = getStore(state.currentStoreId)?.name || "";
    else if (name === "detail") {
      const sake = getSake(state.currentSakeId);
      sub.textContent = sake?.brewery || "";
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function goHome() {
    state.currentStoreId = null;
    state.currentSakeId = null;
    showView("home");
    renderHome();
  }
  function goStore(storeId) {
    state.currentStoreId = storeId;
    state.filter = "all";
    state.search = "";
    $("#search-input").value = "";
    $$(".filter-tab").forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
    showView("store");
    renderStore();
  }
  function goDetail(sakeId) {
    state.currentSakeId = sakeId;
    state.editingRecordId = null;
    showView("detail");
    renderDetail();
  }
  function goSettings() {
    showView("settings");
    renderSettings();
  }

  function goBack() {
    const current = $$(".view").find((v) => !v.hasAttribute("hidden"))?.dataset.view;
    if (current === "detail") {
      if (state.currentStoreId) showView("store");
      else goHome();
      return;
    }
    if (current === "store" || current === "settings") {
      goHome();
      return;
    }
    goHome();
  }

  // ============================================================
  // 描画: ホーム
  // ============================================================

  function renderHome() {
    const list = $("#store-list");
    list.innerHTML = "";
    const stores = state.master?.stores || [];
    for (const store of stores) {
      // 現役スコア: 現在メニューにある銘柄のうち、飲んだ数
      const activeRows = sakesInStore(store.id);
      const activeTotal = activeRows.length;
      const activeDone = activeRows.filter((row) => isDone(row.sake.id)).length;
      const activePct = activeTotal > 0 ? Math.round((activeDone / activeTotal) * 100) : 0;

      // 全期間スコア: 過去にこの店で提供された全銘柄のうち、飲んだ数
      const everRows = sakesEverInStore(store.id);
      const everTotal = everRows.length;
      const everDone = everRows.filter((row) => isDone(row.sake.id)).length;

      const card = document.createElement("button");
      card.className = "store-card";
      card.innerHTML = `
        <span class="store-card-name">${esc(store.name)}</span>
        <span class="store-card-sub">${store.id.toUpperCase()}</span>
        <div class="store-card-progress">
          <div class="pct">${activePct}<span style="font-size:14px;">%</span></div>
          <div class="frac">現役 ${activeDone} / ${activeTotal}</div>
          ${everTotal > activeTotal ? `<div class="frac frac-sub">全期間 ${everDone} / ${everTotal}</div>` : ""}
        </div>
      `;
      card.addEventListener("click", () => goStore(store.id));
      list.appendChild(card);
    }
    updateSyncStatus();
  }

  function updateSyncStatus() {
    const el = $("#sync-status");
    const text = el.querySelector(".sync-text");
    const hasCfg = Storage.hasGitHubConfig();
    const pending = Storage.getPending().length;

    el.classList.remove("ok", "warn", "err");
    if (!hasCfg) {
      el.classList.add("warn");
      text.textContent = "GitHub未設定 — 記録はこの端末のみに保存されます。設定から連携を。";
    } else if (pending > 0) {
      el.classList.add("warn");
      text.textContent = `未同期: ${pending} 件 — タップで再同期`;
      el.onclick = () => syncPending();
      el.style.cursor = "pointer";
    } else {
      el.classList.add("ok");
      text.textContent = `GitHub 同期済み・記録 ${state.records.length} 件`;
      el.onclick = null;
      el.style.cursor = "";
    }
  }

  // ============================================================
  // 描画: 店舗別銘柄一覧
  // ============================================================

  function renderStore() {
    const store = getStore(state.currentStoreId);
    if (!store) return goHome();
    $("#store-title").textContent = store.name;

    // 進捗バーは「現役」基準で計算（分母を固定）
    const activeRows = sakesInStore(store.id);
    const activeDone = activeRows.filter((r) => isDone(r.sake.id)).length;
    const pct = activeRows.length > 0 ? (activeDone / activeRows.length) * 100 : 0;
    $("#progress-fill").style.width = pct + "%";
    $("#progress-count").textContent = `${activeDone} / ${activeRows.length}`;

    // フィルタが "retired" のときだけ引退を含める
    const includeRetired = state.filter === "retired";
    const rows = includeRetired
      ? sakesEverInStore(store.id)
      : activeRows;

    const q = state.search.trim().toLowerCase();
    const filtered = rows.filter(({ sake, retired }) => {
      const done = isDone(sake.id);
      if (state.filter === "unread" && done) return false;
      if (state.filter === "done" && !done) return false;
      if (state.filter === "retired" && !retired) return false;
      if (q) {
        const hay = (sake.name + " " + sake.brewery).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const list = $("#sake-list");
    list.innerHTML = "";

    if (filtered.length === 0) {
      list.innerHTML = `<li class="empty-state">該当する銘柄がありません</li>`;
      return;
    }

    for (const { sake, number, retired, retiredAt } of filtered) {
      const li = document.createElement("li");
      const latest = latestRecord(sake.id);
      const done = !!latest;
      li.className = "sake-item" + (done ? " done" : "") + (retired ? " retired" : "");
      const stars = latest ? "★".repeat(latest.rating) + "☆".repeat(5 - latest.rating) : "";
      const retiredBadge = retired
        ? `<div class="sake-badge sake-badge-retired" title="${esc(retiredAt || "")}に提供終了">終了</div>`
        : "";
      li.innerHTML = `
        <div class="sake-number">${esc(number)}</div>
        <img class="sake-thumb" src="${esc(sake.image_url || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
        <div class="sake-info">
          <div class="sake-name">${esc(sake.name)}</div>
          <div class="sake-brewery">${esc(sake.brewery)}</div>
        </div>
        <div class="sake-meta">
          ${retiredBadge}
          ${done ? `<div class="sake-badge">呑了</div><div class="sake-rating">${stars}</div>` : ""}
        </div>
      `;
      li.addEventListener("click", () => goDetail(sake.id));
      list.appendChild(li);
    }
  }

  // ============================================================
  // 描画: 銘柄詳細 / 記録入力
  // ============================================================
  //
  // フォーム状態は state.editingRecordId で管理:
  //   null: 新規記録モード
  //   (record id): 編集モード
  //
  // 写真は 2 枚 (before/after) を photos: { before: File|null|'keep', after: File|null|'keep' } で持つ
  //   File: 新規選択された画像
  //   null: 写真なし/削除済み
  //   'keep': 既存の画像パスをそのまま維持 (編集時)

  function renderDetail() {
    const sake = getSake(state.currentSakeId);
    if (!sake) return goBack();
    const container = $("#sake-detail");
    const history = recordsFor(sake.id);
    const defaultStore = state.currentStoreId
      || sake.available_at.find((a) => !a.retired_at)?.store
      || sake.available_at[0]?.store
      || "";
    const numbers = sake.available_at.map((a) => {
      const store = getStore(a.store);
      const retiredCls = a.retired_at ? " detail-number-chip-retired" : "";
      const retiredSuffix = a.retired_at ? `<em class="retired-suffix">(終了)</em>` : "";
      return `<span class="detail-number-chip${retiredCls}">${esc(store?.name || a.store)}<strong>${esc(a.number)}</strong>${retiredSuffix}</span>`;
    }).join("");

    const fullyRetired = sake.available_at.every((a) => !!a.retired_at);
    const retiredBanner = fullyRetired
      ? `<div class="retired-banner">この銘柄は現在どの店舗でも提供されていません。過去の記録として表示しています。</div>`
      : "";

    // 編集中の記録があればその値をプリセット
    const editing = state.editingRecordId
      ? history.find((r) => r.id === state.editingRecordId)
      : null;

    container.innerHTML = `
      <div class="detail-header">
        <img class="detail-thumb" src="${esc(sake.image_url || "")}" alt="" onerror="this.style.visibility='hidden'"/>
        <div>
          <div class="detail-brewery">${esc(sake.brewery)}</div>
          <div class="detail-name">${esc(sake.name)}</div>
          <div class="detail-numbers">${numbers}</div>
        </div>
      </div>

      ${retiredBanner}

      <div class="record-section">
        <div class="record-mode-label" id="record-mode-label">
          ${editing ? "記録を編集" : "新しい記録"}
        </div>

        <h4>評価</h4>
        <div class="rating-input" id="rating-input">
          ${[1,2,3,4,5].map(n => `<button class="star-btn" data-rating="${n}" aria-label="${n}つ星">★</button>`).join("")}
        </div>

        <h4>感想メモ</h4>
        <textarea class="memo-input" id="memo-input" placeholder="香り、口あたり、余韻、合わせた肴、など自由に。"></textarea>

        <h4>写真</h4>
        <div class="photo-slots">
          <div class="photo-slot" data-slot="before">
            <div class="photo-slot__label">注ぐ前</div>
            <div class="photo-slot__preview" data-preview></div>
            <label class="photo-slot__btn">
              選択
              <input type="file" accept="image/*" capture="environment" data-file hidden/>
            </label>
            <button type="button" class="photo-slot__remove" data-remove hidden>×</button>
          </div>
          <div class="photo-slot" data-slot="after">
            <div class="photo-slot__label">注いだ後</div>
            <div class="photo-slot__preview" data-preview></div>
            <label class="photo-slot__btn">
              選択
              <input type="file" accept="image/*" capture="environment" data-file hidden/>
            </label>
            <button type="button" class="photo-slot__remove" data-remove hidden>×</button>
          </div>
        </div>

        <h4>飲んだ日時</h4>
        <label class="field">
          <input type="datetime-local" id="drunk-at-input" />
        </label>

        <h4>飲んだ店舗</h4>
        <div class="store-select" id="store-select">
          ${(state.master.stores || []).map(s => `
            <button class="store-chip" data-store="${esc(s.id)}">${esc(s.name)}</button>
          `).join("")}
        </div>

        <div class="button-row">
          <button class="btn btn-primary" id="save-record">${editing ? "更新する" : "この一杯を綴る"}</button>
          ${editing ? `<button class="btn btn-ghost" id="cancel-edit">キャンセル</button>` : ""}
          ${editing ? `<button class="btn btn-danger" id="delete-record">削除</button>` : ""}
        </div>
      </div>

      <div class="history">
        <h4 class="history-heading">これまでの記録 ${history.length > 0 ? `<span class="history-count">${history.length}</span>` : ""}</h4>
        ${history.length === 0
          ? `<div class="history-empty">まだ記録がありません</div>`
          : history.map((r) => {
              const store = getStore(r.store);
              const isEditing = r.id === state.editingRecordId;
              const photos = r.photos || {};
              const thumbs = [];
              if (photos.before) thumbs.push(`<img class="history-thumb" src="${esc(photos.before)}" alt="注ぐ前" loading="lazy" onerror="this.style.display='none'"/>`);
              if (photos.after)  thumbs.push(`<img class="history-thumb" src="${esc(photos.after)}" alt="注いだ後" loading="lazy" onerror="this.style.display='none'"/>`);
              const thumbsHtml = thumbs.length ? `<div class="history-thumbs">${thumbs.join("")}</div>` : "";
              return `
                <div class="history-item ${isEditing ? "history-item--editing" : ""}" data-record="${esc(r.id)}">
                  <div class="history-date">${esc(fmtDate(r.drunk_at))}<br/><span class="history-store">${esc(store?.name || "")}</span></div>
                  <div class="history-body">
                    <div class="history-memo">${esc(r.memo || "(メモなし)")}</div>
                    ${thumbsHtml}
                  </div>
                  <div class="history-rating">${"★".repeat(r.rating || 0)}${"☆".repeat(5 - (r.rating || 0))}</div>
                </div>
              `;
            }).join("")
        }
      </div>
    `;

    // フォーム状態
    let rating = editing?.rating || 0;
    let memo = editing?.memo || "";
    let drunkAt = editing
      ? toLocalDatetimeValue(editing.drunk_at)
      : nowLocalDatetimeValue();
    let storeId = editing?.store || defaultStore;
    // photos: { before: File | null | 'keep', after: ... }
    const photos = {
      before: editing?.photos?.before ? "keep" : null,
      after:  editing?.photos?.after  ? "keep" : null,
    };

    // 星評価
    const starBtns = $$(".star-btn", container);
    function paintStars() {
      starBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.rating) <= rating));
    }
    starBtns.forEach((b) => {
      b.addEventListener("click", () => {
        const v = Number(b.dataset.rating);
        rating = rating === v ? 0 : v;
        paintStars();
      });
    });
    paintStars();

    // メモ
    const memoEl = $("#memo-input", container);
    memoEl.value = memo;
    memoEl.addEventListener("input", (e) => memo = e.target.value);

    // 日時
    const dtInput = $("#drunk-at-input", container);
    dtInput.value = drunkAt;
    dtInput.addEventListener("change", (e) => drunkAt = e.target.value);

    // 店舗選択
    $$(".store-chip", container).forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.store === storeId);
      chip.addEventListener("click", () => {
        storeId = chip.dataset.store;
        $$(".store-chip", container).forEach((c) => c.classList.toggle("active", c === chip));
      });
    });

    // 写真スロット
    $$(".photo-slot", container).forEach((slot) => {
      const slotName = slot.dataset.slot;       // 'before' or 'after'
      const fileInput = $("[data-file]", slot);
      const preview = $("[data-preview]", slot);
      const removeBtn = $("[data-remove]", slot);

      function updatePreview() {
        const p = photos[slotName];
        preview.innerHTML = "";
        removeBtn.hidden = true;
        if (!p) return;

        let url = null;
        if (p === "keep" && editing?.photos?.[slotName]) {
          // 既存画像: リポジトリからの相対パス
          url = editing.photos[slotName];
        } else if (p instanceof File || p instanceof Blob) {
          url = URL.createObjectURL(p);
        }
        if (url) {
          const img = document.createElement("img");
          img.src = url;
          img.className = "photo-preview-img";
          preview.appendChild(img);
          removeBtn.hidden = false;
        }
      }

      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const webpBlob = await resizeToWebp(file);
          photos[slotName] = webpBlob;
          updatePreview();
        } catch (err) {
          toast("画像の変換に失敗しました: " + err.message, "error");
        }
        e.target.value = "";
      });

      removeBtn.addEventListener("click", () => {
        photos[slotName] = null;
        updatePreview();
      });

      updatePreview();
    });

    // 保存/更新ボタン
    $("#save-record", container).addEventListener("click", async () => {
      await saveRecord({
        recordId: editing?.id || null,
        sakeId: sake.id,
        rating, memo: memo.trim(), drunkAt, storeId, photos,
        existing: editing,
      });
    });

    // キャンセル (編集モード時のみ)
    if (editing) {
      $("#cancel-edit", container).addEventListener("click", () => {
        state.editingRecordId = null;
        renderDetail();
      });
      $("#delete-record", container).addEventListener("click", async () => {
        if (!confirm("この記録を削除しますか？")) return;
        await deleteRecordFlow(editing.id);
      });
    }

    // 履歴タップで編集モードへ
    $$(".history-item", container).forEach((item) => {
      item.addEventListener("click", () => {
        const id = item.dataset.record;
        if (state.editingRecordId === id) {
          // 同じ記録をもう一度タップ -> キャンセル
          state.editingRecordId = null;
        } else {
          state.editingRecordId = id;
        }
        renderDetail();
        // 編集モード時は上部フォームにスクロール
        if (state.editingRecordId) {
          $(".record-section", container)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  }

  // 記録の保存 (新規/編集共通)
  async function saveRecord({ recordId, sakeId, rating, memo, drunkAt, storeId, photos, existing }) {
    if (rating === 0 && !memo && !photos.before && !photos.after) {
      if (!confirm("評価もメモも写真も入っていませんが、「呑んだ」記録として保存しますか？")) return;
    }

    const isEdit = !!recordId;
    const id = recordId || genId();
    const saveBtn = $("#save-record");
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中...";

    try {
      // 写真のアップロード (先に画像、あとでrecords.json)
      const photoResults = { before: null, after: null };
      for (const slot of ["before", "after"]) {
        const p = photos[slot];
        if (p === "keep" && existing?.photos?.[slot]) {
          photoResults[slot] = existing.photos[slot];
        } else if (p instanceof Blob) {
          // アップロード
          const path = `data/photos/${id}_${slot}.webp`;
          if (Storage.hasGitHubConfig()) {
            saveBtn.textContent = `写真アップロード中 (${slot})...`;
            await GitHubAPI.putBinary(path, p);
          }
          photoResults[slot] = path;
        } else {
          // null -> なし
          photoResults[slot] = null;
        }
      }

      const record = {
        id,
        sake_id: sakeId,
        rating,
        memo,
        drunk_at: localDatetimeToISO(drunkAt),
        store: storeId,
      };
      // photos は何かあるときだけ追加
      if (photoResults.before || photoResults.after) {
        record.photos = {};
        if (photoResults.before) record.photos.before = photoResults.before;
        if (photoResults.after)  record.photos.after  = photoResults.after;
      }

      Storage.addRecord(record);
      state.records = Storage.getRecords().records;
      Storage.addPending(record.id);

      saveBtn.textContent = "records.json 同期中...";
      if (Storage.hasGitHubConfig()) {
        await syncToGitHub();
      }
      toast(isEdit ? "更新しました" : "保存しました");
    } catch (e) {
      console.error(e);
      toast("保存失敗: " + e.message, "error");
    } finally {
      saveBtn.disabled = false;
    }

    // 編集モード解除して再描画
    state.editingRecordId = null;

    // 編集完了時は一覧に戻らず詳細に留まる (続けて編集できるように)
    if (isEdit) {
      renderDetail();
    } else if (state.currentStoreId) {
      showView("store");
      renderStore();
    } else {
      goHome();
    }
  }

  async function deleteRecordFlow(recordId) {
    Storage.deleteRecord(recordId);
    state.records = Storage.getRecords().records;
    Storage.addPending("__deleted__" + recordId);
    if (Storage.hasGitHubConfig()) {
      try { await syncToGitHub(); } catch (e) { console.error(e); }
    }
    state.editingRecordId = null;
    renderDetail();
    toast("削除しました");
  }

  // 画像を長辺1200pxにリサイズしてWebPに変換
  async function resizeToWebp(file, maxSize = 1200, quality = 0.75) {
    const img = await loadImage(file);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxSize || h > maxSize) {
      if (w >= h) {
        h = Math.round(h * (maxSize / w));
        w = maxSize;
      } else {
        w = Math.round(w * (maxSize / h));
        h = maxSize;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("toBlob returned null")),
        "image/webp",
        quality,
      );
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像読み込み失敗")); };
      img.src = url;
    });
  }

  // ISO -> "YYYY-MM-DDTHH:MM" (ローカルタイム)
  function toLocalDatetimeValue(iso) {
    if (!iso) return nowLocalDatetimeValue();
    const d = new Date(iso);
    if (isNaN(d)) return nowLocalDatetimeValue();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ============================================================
  // 描画: 設定
  // ============================================================

  function renderSettings() {
    const c = Storage.getConfig();
    $("#cfg-repo").value = c.owner && c.repo ? `${c.owner}/${c.repo}` : "";
    $("#cfg-branch").value = c.branch || "main";
    $("#cfg-token").value = c.token || "";

    const master = state.master;
    $("#master-updated").textContent = master?.updated_at || "—";
    $("#master-count").textContent = master ? `${master.sake.length} 銘柄` : "—";
  }

  function wireSettings() {
    $("#cfg-save").addEventListener("click", () => {
      const repo = $("#cfg-repo").value.trim();
      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        toast("owner/repo の形式で入力してください", "error");
        return;
      }
      Storage.setConfig({
        owner,
        repo: repoName,
        branch: $("#cfg-branch").value.trim() || "main",
        token: $("#cfg-token").value.trim(),
      });
      toast("保存しました");
      updateSyncStatus();
    });

    $("#cfg-test").addEventListener("click", async () => {
      const btn = $("#cfg-test");
      btn.disabled = true;
      btn.textContent = "接続中…";
      const result = await GitHubAPI.testConnection();
      btn.disabled = false;
      btn.textContent = "接続テスト";
      toast(result.message, result.ok ? "ok" : "error");
    });

    $("#cfg-export").addEventListener("click", () => {
      const data = Storage.getRecords();
      const blob = new Blob([JSON.stringify({ updated_at: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `records-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    $("#cfg-import").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data.records)) throw new Error("records配列がありません");
        if (!confirm(`${data.records.length} 件を取り込みます。現在の記録は上書きされます。よろしいですか？`)) return;
        Storage.setRecords(data.records, null);
        state.records = data.records;
        toast("取り込みました");
        goHome();
      } catch (err) {
        toast("取り込み失敗: " + err.message, "error");
      }
      e.target.value = "";
    });

    $("#cfg-clear").addEventListener("click", () => {
      if (!confirm("すべての記録をこの端末から削除します。GitHubからは削除されません。よろしいですか？")) return;
      Storage.clearRecords();
      state.records = [];
      state.recordsSha = null;
      toast("削除しました");
      goHome();
    });
  }

  // ============================================================
  // 同期ロジック
  // ============================================================

  async function syncToGitHub() {
    if (state.syncing) return;
    if (!Storage.hasGitHubConfig()) return;
    state.syncing = true;
    try {
      // 現在のリモート状態を取得してshaを更新
      const remote = await GitHubAPI.fetchRecords();
      // ローカル記録でそのままリモートを上書き (単一ユーザー前提・last-write-wins)
      const local = Storage.getRecords().records;
      const { sha } = await GitHubAPI.putRecords(local, remote.sha);
      Storage.setRecords(local, sha);
      state.recordsSha = sha;
      Storage.clearPending();
      updateSyncStatus();
    } catch (e) {
      console.error("sync failed", e);
      toast("同期失敗: " + e.message, "error");
      updateSyncStatus();
    } finally {
      state.syncing = false;
    }
  }

  async function syncPending() {
    if (!Storage.hasGitHubConfig()) return;
    toast("同期中…");
    await syncToGitHub();
    if (!Storage.hasPending()) toast("同期完了");
  }

  // ============================================================
  // データロード
  // ============================================================

  async function loadMaster() {
    // キャッシュ → fetch
    const cached = Storage.getMasterCache();
    if (cached) state.master = cached;
    try {
      const resp = await fetch("data/master.json", { cache: "no-cache" });
      if (resp.ok) {
        const master = await resp.json();
        state.master = master;
        Storage.setMasterCache(master);
      } else if (!cached) {
        throw new Error("master.json が見つかりません");
      }
    } catch (e) {
      if (!cached) {
        document.getElementById("app").innerHTML =
          `<div style="padding:40px 20px; text-align:center;"><h2>マスタ読み込み失敗</h2><p>${esc(e.message)}</p></div>`;
        return false;
      }
      console.warn("master fetch failed, using cache", e);
    }
    return true;
  }

  async function loadRecords() {
    // まずローカルキャッシュを表示
    const cached = Storage.getRecords();
    state.records = cached.records || [];
    state.recordsSha = cached.sha || null;

    // GitHubから最新を取得してマージ (設定があれば)
    if (Storage.hasGitHubConfig()) {
      try {
        const remote = await GitHubAPI.fetchRecords();
        // 未同期保留がなければリモートをそのまま採用
        if (!Storage.hasPending()) {
          state.records = remote.records;
          state.recordsSha = remote.sha;
          Storage.setRecords(state.records, state.recordsSha);
        } else {
          // 未同期がある → リモートとローカルをマージ (ID単位)
          const merged = mergeRecords(remote.records, cached.records);
          state.records = merged;
          state.recordsSha = remote.sha;
          Storage.setRecords(state.records, state.recordsSha);
        }
      } catch (e) {
        console.warn("records fetch failed, using local cache", e);
      }
    }
  }

  function mergeRecords(remote, local) {
    // ID基準でローカル優先にマージ（自分の編集を失わない）
    const map = new Map();
    for (const r of remote) map.set(r.id, r);
    for (const r of local) map.set(r.id, r);
    return Array.from(map.values());
  }

  // ============================================================
  // 初期化
  // ============================================================

  async function init() {
    // ヘッダーナビゲーション
    $(".header-back").addEventListener("click", goBack);
    $(".header-settings").addEventListener("click", goSettings);

    // タイトルクリックでホームへ
    $(".header-title").addEventListener("click", goHome);
    $(".header-title").style.cursor = "pointer";

    // 店舗一覧のフィルタ
    $$(".filter-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.filter = tab.dataset.filter;
        $$(".filter-tab").forEach((b) => b.classList.toggle("active", b === tab));
        renderStore();
      });
    });

    // 検索
    $("#search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderStore();
    });

    // 設定画面のワイヤリング
    wireSettings();

    // データ読み込み
    const ok = await loadMaster();
    if (!ok) return;
    await loadRecords();

    // 初期画面
    goHome();
  }

  // expose for debug
  window.App = { state, syncToGitHub };

  document.addEventListener("DOMContentLoaded", init);
})();
