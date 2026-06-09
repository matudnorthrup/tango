const state = {
  token: localStorage.getItem("kiloToken") || new URLSearchParams(location.search).get("token") || "",
  ledger: null,
};

const basePath = new URL(import.meta.url).pathname
  .replace(/\/app\.js$/u, "")
  .replace(/\/$/u, "");

if (state.token) {
  localStorage.setItem("kiloToken", state.token);
}

const els = {
  authTool: document.getElementById("authTool"),
  bucketGrid: document.getElementById("bucketGrid"),
  deleteBucket: document.getElementById("deleteBucket"),
  deleteBucketForm: document.getElementById("deleteBucketForm"),
  deleteDestination: document.getElementById("deleteDestination"),
  fromBucket: document.getElementById("fromBucket"),
  historyList: document.getElementById("historyList"),
  refreshButton: document.getElementById("refreshButton"),
  statusBand: document.getElementById("statusBand"),
  syncStatus: document.getElementById("syncStatus"),
  toBucket: document.getElementById("toBucket"),
  tokenForm: document.getElementById("tokenForm"),
  totalBalance: document.getElementById("totalBalance"),
  transferForm: document.getElementById("transferForm"),
  createBucketForm: document.getElementById("createBucketForm"),
  unallocatedPanel: document.getElementById("unallocatedPanel"),
};

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
  const response = await fetch(`${basePath}${path}`, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      els.authTool.hidden = false;
    }
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function loadLedger() {
  try {
    const payload = await api("/api/ledger");
    state.ledger = payload.summary;
    render(payload);
  } catch (error) {
    showStatus(error.message, "bad");
  }
}

function render(payload) {
  const summary = payload.summary;
  els.totalBalance.textContent = summary.total;
  els.syncStatus.textContent = payload.exists ? "Ledger ready" : "Ledger preview";
  renderStatus(summary.latestReconciliation);
  renderBuckets(summary);
  renderControls(summary);
  renderHistory(summary);
}

function renderStatus(reconciliation) {
  if (!reconciliation) {
    showStatus("No reconciliation recorded yet.", "");
    return;
  }
  if (reconciliation.status === "match") {
    const pending = reconciliation.pendingSettlementCents > 0
      ? ` with ${reconciliation.pendingSettlement} pending bank settlement`
      : "";
    showStatus(`Reconciled: expected account balance ${reconciliation.expectedExternalBalance}${pending}.`, "good");
    return;
  }
  if (reconciliation.status === "drift") {
    showStatus(`Drift: expected account ${reconciliation.expectedExternalBalance}, account ${reconciliation.externalBalance}, difference ${reconciliation.drift}.`, "bad");
    return;
  }
  showStatus("Reconciliation unavailable.", "bad");
}

function showStatus(text, tone = "") {
  els.statusBand.hidden = !text;
  els.statusBand.className = `status-band ${tone}`.trim();
  els.statusBand.textContent = text || "";
}

function renderBuckets(summary) {
  const maxBalance = Math.max(
    1,
    ...summary.buckets.map((bucket) => bucket.balanceCents || 0),
  );
  const unallocated = summary.buckets.find((bucket) => bucket.role === "holding" || bucket.id === "to-allocate");
  els.unallocatedPanel.innerHTML = "";
  els.bucketGrid.innerHTML = "";

  if (unallocated) {
    els.unallocatedPanel.append(createBucketCard(unallocated, maxBalance, true));
  }

  for (const bucket of summary.buckets) {
    if (bucket.id === unallocated?.id) {
      continue;
    }
    els.bucketGrid.append(createBucketCard(bucket, maxBalance, false));
  }
}

function createBucketCard(bucket, maxBalance, featured) {
  const fill = Math.min(100, Math.round((bucket.balanceCents / maxBalance) * 100));
  const article = document.createElement("article");
  article.className = `bucket ${bucket.role}${featured ? " featured" : ""}`;
  article.innerHTML = `
    <div>
      <div class="bucket-title">
        <h3></h3>
        <span class="badge"></span>
      </div>
      <strong></strong>
      <p class="bucket-meta"></p>
    </div>
    <div class="bucket-meter" aria-hidden="true"><span style="--fill: ${fill}%"></span></div>
  `;
  article.querySelector("h3").textContent = bucket.name;
  article.querySelector("strong").textContent = bucket.balance;
  article.querySelector(".badge").textContent = bucket.role === "protected"
    ? "Protected"
    : bucket.role === "holding"
      ? "Ready to assign"
      : "Flexible";
  article.querySelector(".bucket-meta").textContent = bucket.role === "holding"
    ? "Available for you to divide into other buckets"
    : bucket.canDelete ? "Discretionary" : "Core";
  return article;
}

function renderControls(summary) {
  const allBuckets = summary.buckets;
  const transferSources = allBuckets.filter((bucket) => bucket.canTransferOut && bucket.balanceCents > 0);
  const transferDestinations = allBuckets;
  const deletable = allBuckets.filter((bucket) => bucket.canDelete);

  fillSelect(els.fromBucket, transferSources, "No funded flexible bucket");
  fillSelect(els.toBucket, transferDestinations, "No buckets");
  fillSelect(els.deleteBucket, deletable, "No deletable bucket");
  fillSelect(els.deleteDestination, transferDestinations, "No buckets");
}

function fillSelect(select, buckets, emptyLabel) {
  select.innerHTML = "";
  if (buckets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const bucket of buckets) {
    const option = document.createElement("option");
    option.value = bucket.id;
    option.textContent = `${bucket.name} ${bucket.balance}`;
    select.append(option);
  }
}

function renderHistory(summary) {
  const bucketsById = new Map(summary.buckets.map((bucket) => [bucket.id, bucket.name]));
  const movements = Array.isArray(summary.movements) ? summary.movements : [];
  els.historyList.innerHTML = "";

  if (movements.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No history yet.";
    els.historyList.append(empty);
    return;
  }

  for (const movement of movements) {
    const item = document.createElement("li");
    item.className = `history-item ${movement.type}`;

    const title = document.createElement("div");
    title.className = "history-title";

    const label = document.createElement("span");
    label.textContent = movementLabel(movement, bucketsById);
    title.append(label);

    const amount = movementAmount(movement);
    if (amount) {
      const amountEl = document.createElement("strong");
      amountEl.textContent = amount;
      title.append(amountEl);
    }

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = [formatMovementDate(movement), actorLabel(movement.actor)].filter(Boolean).join(" · ");

    const detailText = movementDetail(movement, bucketsById);
    item.append(title, meta);
    if (detailText) {
      const detail = document.createElement("p");
      detail.className = "history-detail";
      detail.textContent = detailText;
      item.append(detail);
    }

    els.historyList.append(item);
  }
}

function movementLabel(movement, bucketsById) {
  if (movement.type === "funding") {
    return "Contribution";
  }
  if (movement.type === "transfer") {
    return `${bucketName(movement.fromBucketId, bucketsById)} to ${bucketName(movement.toBucketId, bucketsById)}`;
  }
  if (movement.type === "spend") {
    return `Deduction from ${bucketName(movement.fromBucketId, bucketsById)}`;
  }
  if (movement.type === "settlement") {
    return "Bank settlement";
  }
  if (movement.type === "historical_spend") {
    return `Historical: ${movement.payee || bucketName(movement.fromBucketId, bucketsById)}`;
  }
  if (movement.type === "bucket_create") {
    return `Created ${bucketName(movement.toBucketId, bucketsById)} bucket`;
  }
  if (movement.type === "bucket_delete") {
    return `Deleted ${bucketName(movement.fromBucketId, bucketsById)} bucket`;
  }
  return movement.type.replace(/_/gu, " ");
}

function movementAmount(movement) {
  if (movement.type === "bucket_create" || movement.type === "bucket_delete") {
    return "";
  }
  if (movement.type === "spend" || movement.type === "historical_spend") {
    return `-${formatCents(movement.amountCents)}`;
  }
  if (movement.type === "funding") {
    return `+${formatCents(movement.amountCents)}`;
  }
  if (movement.type === "settlement") {
    return formatCents(movement.amountCents);
  }
  return formatCents(movement.amountCents);
}

function movementDetail(movement, bucketsById) {
  const allocations = Array.isArray(movement.allocations)
    ? movement.allocations
      .map((allocation) => `${bucketName(allocation.bucketId, bucketsById)} +${formatCents(allocation.amountCents)}`)
      .join(", ")
    : "";
  const bucket = movement.type === "historical_spend" && movement.fromBucketId
    ? bucketName(movement.fromBucketId, bucketsById)
    : "";
  const settlement = movement.type === "settlement" && Array.isArray(movement.settledMovementIds)
    ? `${movement.settledMovementIds.length} spend${movement.settledMovementIds.length === 1 ? "" : "s"} settled`
    : "";
  const external = movement.externalId ? `External id: ${movement.externalId}` : "";
  return [bucket, movement.description, settlement, external, allocations].filter(Boolean).join(" · ");
}

function bucketName(bucketId, bucketsById) {
  if (!bucketId) {
    return "Unknown";
  }
  if (bucketsById.has(bucketId)) {
    return bucketsById.get(bucketId);
  }
  if (bucketId === "to-allocate") {
    return "Unallocated";
  }
  return bucketId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function actorLabel(actor) {
  if (!actor) {
    return "";
  }
  return `${actor.charAt(0).toUpperCase()}${actor.slice(1)}`;
}

function formatMovementDate(movement) {
  if (movement.occurredOn) {
    const date = new Date(`${movement.occurredOn}T12:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  return formatWhen(movement.createdAt);
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCents(cents) {
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${remainder}`;
}

async function postForm(path, form, extra = {}) {
  const formData = new FormData(form);
  const body = Object.fromEntries([...formData.entries()].filter(([, value]) => String(value).trim().length > 0));
  const payload = await api(path, {
    method: "POST",
    body: JSON.stringify({ actor: "child", ...body, ...extra }),
  });
  state.ledger = payload.summary;
  render(payload);
}

els.refreshButton.addEventListener("click", () => {
  loadLedger();
});

els.transferForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await postForm("/api/transfer", els.transferForm);
    els.transferForm.reset();
  } catch (error) {
    showStatus(error.message, "bad");
  }
});

els.createBucketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await postForm("/api/buckets/create", els.createBucketForm);
    els.createBucketForm.reset();
  } catch (error) {
    showStatus(error.message, "bad");
  }
});

els.deleteBucketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await postForm("/api/buckets/delete", els.deleteBucketForm);
  } catch (error) {
    showStatus(error.message, "bad");
  }
});

els.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = new FormData(els.tokenForm).get("token");
  state.token = String(token || "");
  localStorage.setItem("kiloToken", state.token);
  els.authTool.hidden = true;
  loadLedger();
});

loadLedger();
