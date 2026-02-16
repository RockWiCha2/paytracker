/* Pay Tracker (LocalStorage + Supabase, Stage 3)
   - Add / edit / delete shifts
   - Scheduled vs actual hours + pay
   - Weekly summary (Mon–Sun)
   - Payment date = Friday of following week (weekEnd Sunday + 5 days)
   - Export/Import JSON
   - Cloud sync (Supabase) when signed in; LocalStorage when signed out
*/

const LS_KEY = "paytracker_shifts_v1";

// --------- Supabase (cloud sync) ----------
const SUPABASE_URL = "https://ephskckdgmisocwjzond.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_LcauD3kUOZiQcJoTVfUK6A_aZwDs89q";

const supabaseClient = window.supabase?.createClient
	? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
	: null;


let useCloud = false;

// --------- Sync settings ----------
const SYNC_INTERVAL_MS = 10000; // every 10s
let syncTimerId = null;
let syncInFlight = false;

let shifts = [];
let editingId = null;

// --------- DOM ----------
const form = document.getElementById("shiftForm");

const dateWorkedEl = document.getElementById("dateWorked");
const hourlyRateEl = document.getElementById("hourlyRate");
const notesEl = document.getElementById("notes");

const schedStartEl = document.getElementById("schedStart");
const schedEndEl = document.getElementById("schedEnd");
const schedBreakEl = document.getElementById("schedBreak");

const actStartEl = document.getElementById("actStart");
const actEndEl = document.getElementById("actEnd");
const actBreakEl = document.getElementById("actBreak");
const paidBreakEl = document.getElementById("paidBreak");

const formErrorEl = document.getElementById("formError");

const submitBtn = document.getElementById("submitBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");

const shiftsTbody = document.getElementById("shiftsTbody");
const weeksWrap = document.getElementById("weeksWrap");

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

// Auth UI (Account card)
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const signUpBtn = document.getElementById("signUpBtn");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authMsgEl = document.getElementById("authMsg");

const syncStatusEl = document.getElementById("syncStatus");
const syncBarEl = document.getElementById("syncBar");
const syncBarFillEl = document.getElementById("syncBarFill");

// --------- Utils ----------
function safeNumber(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

function fmtMoney(n) {
	const v = round2(n);
	return `£${v.toFixed(2)}`;
}

function fmtHours(n) {
	return round2(n).toFixed(2);
}

function parseISODate(dateStr) {
	// dateStr "YYYY-MM-DD" -> Date at midnight local
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d);
}

function fmtDateLong(d) {
	// e.g. Mon 16 Feb 2026
	return d.toLocaleDateString("en-GB", {
		weekday: "short",
		day: "2-digit",
		month: "short",
		year: "numeric"
	});
}

function timeToMins(t) {
	// "HH:MM" -> minutes since midnight
	if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
	const [hh, mm] = t.split(":").map(Number);
	return hh * 60 + mm;
}

function minsWorked(startTime, endTime, breakMins, paidBreak) {
	const s = timeToMins(startTime);
	const e = timeToMins(endTime);
	if (s == null || e == null) return null;

	let dur = e - s;
	if (dur < 0) dur += 24 * 60; // overnight shift

	if (!paidBreak) {
		dur -= safeNumber(breakMins, 0);
	}
	return dur;
}

function minsToHours(mins) {
	return mins / 60;
}

// Week starts Monday
function getWeekStart(dateObj) {
	const d = new Date(dateObj);
	const day = d.getDay(); // 0 Sun .. 6 Sat
	const diff = (day === 0 ? -6 : 1) - day; // move to Monday
	d.setDate(d.getDate() + diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

function addDays(dateObj, days) {
	const d = new Date(dateObj);
	d.setDate(d.getDate() + days);
	return d;
}

function dateKey(d) {
	return d.toISOString().slice(0, 10);
}

function isCompleted(shift) {
	const a = shift.actual;
	return !!(a && a.start && a.end);
}

// --------- Storage (Local) ----------
function loadLocal() {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveLocal() {
	localStorage.setItem(LS_KEY, JSON.stringify(shifts));
}

// --------- Cloud storage helpers ----------
function setAuthMsg(msg) {
	if (authMsgEl) authMsgEl.textContent = msg || "";
}

let lastSyncAt = null;

function setSyncStatus(msg) {
	if (syncStatusEl) syncStatusEl.textContent = msg || "";
}

function setSyncing(isSyncing) {
	if (!syncBarEl) return;

	// Hide the bar entirely when signed out
	if (!useCloud) {
		syncBarEl.hidden = true;
		syncBarEl.classList.remove("syncing");
		if (syncBarFillEl) syncBarFillEl.style.width = "0%";
		return;
	}

	syncBarEl.hidden = false;
	if (isSyncing) syncBarEl.classList.add("syncing");
	else syncBarEl.classList.remove("syncing");

	if (syncBarFillEl) syncBarFillEl.style.width = isSyncing ? "100%" : "0%";
}

function fmtTimeOnly(d) {
	return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rowToShift(r) {
	return {
		id: r.id,
		createdAt: new Date(r.created_at).getTime(),
		dateWorked: r.date_worked,
		rate: Number(r.rate),
		notes: r.notes ?? "",
		paidBreak: !!r.paid_break,
		sched: {
			start: r.sched_start,
			end: r.sched_end,
			breakMins: r.sched_break_mins
		},
		actual: {
			start: r.act_start ?? "",
			end: r.act_end ?? "",
			breakMins: r.act_break_mins ?? 0
		}
	};
}

function shiftToRow(shift, userId) {
	return {
		id: shift.id,
		user_id: userId,
		date_worked: shift.dateWorked,
		rate: shift.rate,
		notes: shift.notes,
		paid_break: !!shift.paidBreak,
		sched_start: shift.sched.start,
		sched_end: shift.sched.end,
		sched_break_mins: shift.sched.breakMins,
		act_start: shift.actual?.start || null,
		act_end: shift.actual?.end || null,
		act_break_mins: shift.actual?.breakMins ?? 0
	};
}

async function cloudLoadShifts() {
	const { data, error } = await supabaseClient
		.from("shifts")
		.select("*")
		.order("date_worked", { ascending: false })
		.order("created_at", { ascending: false });

	if (error) throw error;
	return (data ?? []).map(rowToShift);
}

async function cloudInsertShift(shift) {
	const { data: u, error: uErr } = await supabaseClient.auth.getUser();
	if (uErr) throw uErr;
	if (!u?.user) throw new Error("Not signed in.");

	const { error } = await supabaseClient.from("shifts").insert(shiftToRow(shift, u.user.id));
	if (error) throw error;
}

async function cloudUpdateShift(shift) {
	const patch = {
		date_worked: shift.dateWorked,
		rate: shift.rate,
		notes: shift.notes,
		paid_break: !!shift.paidBreak,
		sched_start: shift.sched.start,
		sched_end: shift.sched.end,
		sched_break_mins: shift.sched.breakMins,
		act_start: shift.actual?.start || null,
		act_end: shift.actual?.end || null,
		act_break_mins: shift.actual?.breakMins ?? 0
	};

	const { error } = await supabaseClient.from("shifts").update(patch).eq("id", shift.id);
	if (error) throw error;
}

async function cloudDeleteShift(id) {
	const { error } = await supabaseClient.from("shifts").delete().eq("id", id);
	if (error) throw error;
}

// --------- Sync helpers ----------
function shiftComparableObject(s) {
	return {
		id: s.id,
		dateWorked: s.dateWorked,
		rate: Number(s.rate),
		notes: s.notes ?? "",
		paidBreak: !!s.paidBreak,
		sched: {
			start: s.sched?.start ?? "",
			end: s.sched?.end ?? "",
			breakMins: Number(s.sched?.breakMins ?? 0)
		},
		actual: {
			start: s.actual?.start ?? "",
			end: s.actual?.end ?? "",
			breakMins: Number(s.actual?.breakMins ?? 0)
		}
	};
}

function shiftsDiffer(a, b) {
	// Compare only the fields we actually store/sync
	return JSON.stringify(shiftComparableObject(a)) !== JSON.stringify(shiftComparableObject(b));
}

async function cloudUpsertShifts(shiftsToUpsert) {
	if (!shiftsToUpsert.length) return;

	const { data: u, error: uErr } = await supabaseClient.auth.getUser();
	if (uErr) throw uErr;
	if (!u?.user) throw new Error("Not signed in.");

	const rows = shiftsToUpsert.map(s => shiftToRow(s, u.user.id));

	// Upsert by primary key id (insert if missing, update if exists)
	const { error } = await supabaseClient
		.from("shifts")
		.upsert(rows, { onConflict: "id" });

	if (error) throw error;
}

async function syncLocalToCloudOnce() {
	if (!useCloud || !supabaseClient) return;
	if (syncInFlight) return;

	syncInFlight = true;
	setSyncing(true);
	setSyncStatus("Cloud sync: On • Syncing…");
	try {
		// Pull cloud state
		const cloud = await cloudLoadShifts();
		const cloudById = new Map(cloud.map(s => [s.id, s]));

		// Determine what needs uploading (missing in cloud OR differs)
		const toUpsert = [];
		for (const localShift of shifts) {
			const cloudShift = cloudById.get(localShift.id);
			if (!cloudShift || shiftsDiffer(localShift, cloudShift)) {
				toUpsert.push(localShift);
			}
		}

		if (toUpsert.length) {
			await cloudUpsertShifts(toUpsert);
		}

		// Re-pull to get the canonical server state
		const merged = await cloudLoadShifts();
		shifts = merged;
		saveLocal(); // keep local as offline cache
		render();
		lastSyncAt = new Date();
		setSyncStatus(`Cloud sync: On • Last synced ${fmtTimeOnly(lastSyncAt)}`);
	} catch (e) {
		setSyncStatus(`Cloud sync: On • Sync failed (${e?.message ?? "error"})`);
	} finally {
		setSyncing(false);
		syncInFlight = false;
	}
}

function startSyncTimer() {
	if (syncTimerId != null) return;
	syncTimerId = setInterval(() => {
		syncLocalToCloudOnce();
	}, SYNC_INTERVAL_MS);
}

function stopSyncTimer() {
	if (syncTimerId == null) return;
	clearInterval(syncTimerId);
	syncTimerId = null;
}

async function refreshAuthState() {
	if (!supabaseClient) {
		useCloud = false;
		setAuthMsg("Supabase not loaded — using local storage.");
		shifts = loadLocal();
		setSyncStatus("Cloud sync: Off");
		setSyncing(false);
		render();
		stopSyncTimer();
		return;
	}

	const { data } = await supabaseClient.auth.getSession();
	const signedIn = !!data.session;

	useCloud = signedIn;
	if (signOutBtn) signOutBtn.hidden = !signedIn;
	setSyncStatus(signedIn ? "Cloud sync: On" : "Cloud sync: Off");
	setSyncing(false);

	if (signedIn) {
		setAuthMsg("Signed in — using cloud sync.");
		shifts = await cloudLoadShifts();
	} else {
		setAuthMsg("Not signed in — using local storage.");
		shifts = loadLocal();
	}

	if (signedIn) startSyncTimer();
	else stopSyncTimer();

	render();
}

// --------- Validation ----------
function validateShiftInput(input) {
	const errors = [];

	if (!input.dateWorked) errors.push("Pick a date.");
	if (!input.schedStart || !input.schedEnd) errors.push("Scheduled start and end are required.");
	if (safeNumber(input.schedBreakMins, 0) < 0) errors.push("Scheduled break can’t be negative.");

	const rate = safeNumber(input.rate, NaN);
	if (!Number.isFinite(rate) || rate <= 0) errors.push("Hourly rate must be greater than 0.");

	const hasActualStart = !!input.actStart;
	const hasActualEnd = !!input.actEnd;
	if (hasActualStart !== hasActualEnd) errors.push("If you enter actual start, you must enter actual end (and vice-versa).");
	if (safeNumber(input.actBreakMins ?? 0, 0) < 0) errors.push("Actual break can’t be negative.");

	// sanity check: scheduled minutes after break > 0
	const schedMins = minsWorked(input.schedStart, input.schedEnd, input.schedBreakMins, input.paidBreak);
	if (schedMins != null && schedMins <= 0) errors.push("Scheduled hours look invalid (break may be too long).");

	// sanity check: actual minutes after break > 0 (only if provided)
	if (hasActualStart && hasActualEnd) {
		const actMins = minsWorked(input.actStart, input.actEnd, input.actBreakMins ?? 0, input.paidBreak);
		if (actMins != null && actMins <= 0) errors.push("Actual hours look invalid (break may be too long).");
	}

	return errors;
}

// --------- Calculations ----------
function calcForShift(shift) {
	const rate = safeNumber(shift.rate, 0);

	const schedMins = minsWorked(shift.sched.start, shift.sched.end, shift.sched.breakMins, shift.paidBreak);
	const schedHours = schedMins == null ? 0 : minsToHours(schedMins);
	const schedPay = schedHours * rate;

	let actHours = 0;
	let actPay = 0;

	if (shift.actual && shift.actual.start && shift.actual.end) {
		const actMins = minsWorked(shift.actual.start, shift.actual.end, shift.actual.breakMins ?? 0, shift.paidBreak);
		actHours = actMins == null ? 0 : minsToHours(actMins);
		actPay = actHours * rate;
	}

	return {
		schedHours,
		schedPay,
		actHours,
		actPay,
		diffPay: actPay - schedPay
	};
}

function buildWeeklySummaries(shiftsArr) {
	const map = new Map();

	for (const s of shiftsArr) {
		const workedDate = parseISODate(s.dateWorked);
		const weekStart = getWeekStart(workedDate);
		const weekId = dateKey(weekStart);

		if (!map.has(weekId)) {
			const weekEnd = addDays(weekStart, 6); // Sunday
			const payDate = addDays(weekEnd, 5);   // Friday following week
			map.set(weekId, {
				weekStart,
				weekEnd,
				payDate,
				schedHours: 0,
				schedPay: 0,
				actHours: 0,
				actPay: 0,
				shiftsCount: 0,
				completedCount: 0
			});
		}

		const w = map.get(weekId);
		const c = calcForShift(s);
		w.schedHours += c.schedHours;
		w.schedPay += c.schedPay;
		w.actHours += c.actHours;
		w.actPay += c.actPay;
		w.shiftsCount += 1;
		if (isCompleted(s)) w.completedCount += 1;
	}

	// sort newest first by weekStart
	return Array.from(map.values()).sort((a, b) => b.weekStart - a.weekStart);
}

// --------- Rendering ----------
function render() {
	const sorted = shifts.slice().sort((a, b) => {
		if (a.dateWorked === b.dateWorked) return (b.createdAt ?? 0) - (a.createdAt ?? 0);
		return b.dateWorked.localeCompare(a.dateWorked);
	});

	renderShiftsTable(sorted);
	renderWeekly(buildWeeklySummaries(sorted));
}

function renderShiftsTable(sorted) {
	shiftsTbody.innerHTML = "";

	for (const s of sorted) {
		const c = calcForShift(s);

		const tr = document.createElement("tr");

		const dateTd = document.createElement("td");
		dateTd.textContent = s.dateWorked;

		const statusTd = document.createElement("td");
		const badge = document.createElement("span");
		badge.className = "badge " + (isCompleted(s) ? "ok" : "warn");
		badge.textContent = isCompleted(s) ? "Completed" : "Scheduled";
		statusTd.appendChild(badge);

		const schedH = document.createElement("td");
		schedH.textContent = fmtHours(c.schedHours);

		const schedP = document.createElement("td");
		schedP.textContent = fmtMoney(c.schedPay);

		const actH = document.createElement("td");
		const actP = document.createElement("td");
		const diffP = document.createElement("td");

		if (isCompleted(s)) {
			actH.textContent = fmtHours(c.actHours);
			actP.textContent = fmtMoney(c.actPay);
			diffP.textContent = fmtMoney(c.diffPay);
		} else {
			actH.textContent = "N/A";
			actP.textContent = "N/A";
			diffP.textContent = "N/A";
		}

		const actionsTd = document.createElement("td");

		const editBtn = document.createElement("button");
		editBtn.type = "button";
		editBtn.className = "secondary";
		editBtn.textContent = "Edit";
		editBtn.addEventListener("click", () => startEdit(s.id));

		const delBtn = document.createElement("button");
		delBtn.type = "button";
		delBtn.className = "danger secondary";
		delBtn.textContent = "Delete";
		delBtn.addEventListener("click", () => onDelete(s.id));

		actionsTd.appendChild(editBtn);
		actionsTd.appendChild(document.createTextNode(" "));
		actionsTd.appendChild(delBtn);

		tr.appendChild(dateTd);
		tr.appendChild(statusTd);
		tr.appendChild(schedH);
		tr.appendChild(schedP);
		tr.appendChild(actH);
		tr.appendChild(actP);
		tr.appendChild(diffP);
		tr.appendChild(actionsTd);

		shiftsTbody.appendChild(tr);
	}

	if (sorted.length === 0) {
		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = 8;
		td.className = "muted";
		td.textContent = "No shifts yet. Add your first one above.";
		tr.appendChild(td);
		shiftsTbody.appendChild(tr);
	}
}

function renderWeekly(weeks) {
	weeksWrap.innerHTML = "";

	if (weeks.length === 0) {
		const p = document.createElement("p");
		p.className = "muted";
		p.textContent = "Weekly summaries will appear here once you add shifts.";
		weeksWrap.appendChild(p);
		return;
	}

	for (const w of weeks) {
		const card = document.createElement("div");
		card.className = "weekCard";

		const title = document.createElement("h4");
		title.textContent = `${fmtDateLong(w.weekStart)} – ${fmtDateLong(w.weekEnd)}`;
		card.appendChild(title);

		const k1 = kvRow("Scheduled", `${fmtHours(w.schedHours)} hrs • ${fmtMoney(w.schedPay)}`);
		const k2 = kvRow("Actual", `${fmtHours(w.actHours)} hrs • ${fmtMoney(w.actPay)}`);
		const diff = kvRow("Difference", `${fmtMoney(w.actPay - w.schedPay)}`);
		const pay = kvRow("Pay date", `${fmtDateLong(w.payDate)}`);

		card.appendChild(k1);
		card.appendChild(k2);
		card.appendChild(diff);
		card.appendChild(pay);

		const pills = document.createElement("div");
		pills.className = "pillRow";

		const p1 = document.createElement("span");
		p1.className = "pill";
		p1.textContent = `Shifts: ${w.shiftsCount}`;

		const p2 = document.createElement("span");
		p2.className = "pill";
		p2.textContent = `Completed: ${w.completedCount}/${w.shiftsCount}`;

		pills.appendChild(p1);
		pills.appendChild(p2);

		card.appendChild(pills);

		weeksWrap.appendChild(card);
	}
}

function kvRow(label, value) {
	const row = document.createElement("div");
	row.className = "kv";

	const l = document.createElement("span");
	l.textContent = label;

	const v = document.createElement("b");
	v.textContent = value;

	row.appendChild(l);
	row.appendChild(v);
	return row;
}

// --------- Form helpers ----------
function getFormInput() {
	return {
		dateWorked: dateWorkedEl.value,
		rate: safeNumber(hourlyRateEl.value, NaN),
		notes: (notesEl.value || "").trim(),
		paidBreak: !!paidBreakEl?.checked,

		schedStart: schedStartEl.value,
		schedEnd: schedEndEl.value,
		schedBreakMins: safeNumber(schedBreakEl.value, 0),

		actStart: actStartEl.value || "",
		actEnd: actEndEl.value || "",
		actBreakMins: safeNumber(actBreakEl.value, 0)
	};
}

function clearError() {
	formErrorEl.textContent = "";
}

function setError(msg) {
	formErrorEl.textContent = msg;
}

function resetForm() {
	form.reset();
	schedBreakEl.value = "0";
	actBreakEl.value = "0";
	if (paidBreakEl) paidBreakEl.checked = false;
	editingId = null;
	submitBtn.textContent = "Add shift";
	cancelEditBtn.hidden = true;
	clearError();
}

function fillFormFromShift(shift) {
	dateWorkedEl.value = shift.dateWorked;
	hourlyRateEl.value = shift.rate;
	notesEl.value = shift.notes ?? "";
	if (paidBreakEl) paidBreakEl.checked = !!shift.paidBreak;

	schedStartEl.value = shift.sched.start;
	schedEndEl.value = shift.sched.end;
	schedBreakEl.value = shift.sched.breakMins ?? 0;

	actStartEl.value = shift.actual?.start ?? "";
	actEndEl.value = shift.actual?.end ?? "";
	actBreakEl.value = shift.actual?.breakMins ?? 0;
}

// --------- Actions ----------
async function addShiftFromInput(input) {
	const shift = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		dateWorked: input.dateWorked,
		rate: input.rate,
		notes: input.notes,
		paidBreak: !!input.paidBreak,
		sched: {
			start: input.schedStart,
			end: input.schedEnd,
			breakMins: input.schedBreakMins
		},
		actual: (input.actStart && input.actEnd) ? {
			start: input.actStart,
			end: input.actEnd,
			breakMins: input.actBreakMins
		} : {
			start: "",
			end: "",
			breakMins: input.actBreakMins
		}
	};

	shifts.push(shift);

	try {
		if (useCloud) {
			await cloudInsertShift(shift);
			shifts = await cloudLoadShifts();
		} else {
			saveLocal();
		}
		render();
		resetForm();
	} catch (e) {
		setError(e?.message ?? "Save failed.");
		if (!useCloud) saveLocal();
		render();
	}
}

async function updateShiftFromInput(id, input) {
	const idx = shifts.findIndex(s => s.id === id);
	if (idx === -1) return;

	const updated = {
		...shifts[idx],
		dateWorked: input.dateWorked,
		rate: input.rate,
		notes: input.notes,
		paidBreak: !!input.paidBreak,
		sched: {
			start: input.schedStart,
			end: input.schedEnd,
			breakMins: input.schedBreakMins
		},
		actual: (input.actStart && input.actEnd) ? {
			start: input.actStart,
			end: input.actEnd,
			breakMins: input.actBreakMins
		} : {
			start: "",
			end: "",
			breakMins: input.actBreakMins
		}
	};

	shifts[idx] = updated;

	try {
		if (useCloud) {
			await cloudUpdateShift(updated);
			shifts = await cloudLoadShifts();
		} else {
			saveLocal();
		}
		render();
		resetForm();
	} catch (e) {
		setError(e?.message ?? "Update failed.");
		if (!useCloud) saveLocal();
		render();
	}
}

function startEdit(id) {
	const s = shifts.find(x => x.id === id);
	if (!s) return;

	editingId = id;
	fillFormFromShift(s);
	submitBtn.textContent = "Save changes";
	cancelEditBtn.hidden = false;
	clearError();

	form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function onDelete(id) {
	const s = shifts.find(x => x.id === id);
	if (!s) return;

	const ok = confirm(`Delete shift on ${s.dateWorked}?`);
	if (!ok) return;

	shifts = shifts.filter(x => x.id !== id);

	try {
		if (useCloud) {
			await cloudDeleteShift(id);
			shifts = await cloudLoadShifts();
		} else {
			saveLocal();
		}
		render();
	} catch (e) {
		setError(e?.message ?? "Delete failed.");
		if (!useCloud) saveLocal();
		render();
	}

	if (editingId === id) resetForm();
}

// --------- Export / Import ----------
function downloadText(filename, text) {
	const blob = new Blob([text], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

function exportJSON() {
	const payload = {
		version: 1,
		exportedAt: new Date().toISOString(),
		shifts
	};
	downloadText(
		`paytracker_export_${new Date().toISOString().slice(0, 10)}.json`,
		JSON.stringify(payload, null, 2)
	);
}

async function importJSONFile(file) {
	const text = await file.text();
	const parsed = JSON.parse(text);

	const incoming = Array.isArray(parsed) ? parsed : parsed.shifts;
	if (!Array.isArray(incoming)) throw new Error("Invalid JSON format.");

	const cleaned = incoming
		.filter(s => s && typeof s === "object" && typeof s.id === "string" && typeof s.dateWorked === "string")
		.map(s => ({
			id: s.id,
			createdAt: s.createdAt ?? Date.now(),
			dateWorked: s.dateWorked,
			rate: safeNumber(s.rate, 0),
			notes: s.notes ?? "",
			paidBreak: !!s.paidBreak,
			sched: {
				start: s.sched?.start ?? "",
				end: s.sched?.end ?? "",
				breakMins: safeNumber(s.sched?.breakMins, 0)
			},
			actual: {
				start: s.actual?.start ?? "",
				end: s.actual?.end ?? "",
				breakMins: safeNumber(s.actual?.breakMins, 0)
			}
		}));

	shifts = cleaned;
	saveLocal();
	render();
	resetForm();

	// If signed in, upload imported data to your account automatically
	if (useCloud) {
		await syncLocalToCloudOnce();
	}
}

// --------- Events ----------
form.addEventListener("submit", async (e) => {
	e.preventDefault();
	clearError();

	const input = getFormInput();
	const errs = validateShiftInput(input);
	if (errs.length) {
		setError(errs[0]);
		return;
	}

	if (editingId == null) await addShiftFromInput(input);
	else await updateShiftFromInput(editingId, input);
});

cancelEditBtn.addEventListener("click", () => resetForm());

copyBtn.addEventListener("click", () => {
	actStartEl.value = schedStartEl.value;
	actEndEl.value = schedEndEl.value;
	actBreakEl.value = schedBreakEl.value;
});

clearBtn.addEventListener("click", () => resetForm());

exportBtn.addEventListener("click", exportJSON);

importInput.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;

	try {
		await importJSONFile(file);
	} catch (err) {
		setError(err?.message ?? "Import failed.");
	} finally {
		importInput.value = "";
	}
});

// --------- Auth events ----------
if (signUpBtn) {
	signUpBtn.addEventListener("click", async () => {
		clearError();
		setAuthMsg("Signing up…");

		const email = (emailEl?.value || "").trim();
		const password = passwordEl?.value || "";

		if (!email || !password) {
			setAuthMsg("Enter an email and password.");
			return;
		}
		if (!supabaseClient) {
			setAuthMsg("Supabase not loaded.");
			return;
		}

		const { error } = await supabaseClient.auth.signUp({ email, password });
		setAuthMsg(error ? error.message : "Account created. Now sign in.");
	});
}

if (signInBtn) {
	signInBtn.addEventListener("click", async () => {
		clearError();
		setAuthMsg("Signing in…");

		const email = (emailEl?.value || "").trim();
		const password = passwordEl?.value || "";

		if (!email || !password) {
			setAuthMsg("Enter an email and password.");
			return;
		}
		if (!supabaseClient) {
			setAuthMsg("Supabase not loaded.");
			return;
		}

		const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
		if (error) {
			setAuthMsg(error.message);
			return;
		}

		await refreshAuthState();
		await syncLocalToCloudOnce();
	});
}

if (signOutBtn) {
	signOutBtn.addEventListener("click", async () => {
		clearError();
		if (!supabaseClient) return;
		await supabaseClient.auth.signOut();
		await refreshAuthState();
		setSyncing(false);
		setSyncStatus("Cloud sync: Off");
	});
}

// --------- Init ----------
async function init() {
	await refreshAuthState();
}
init();