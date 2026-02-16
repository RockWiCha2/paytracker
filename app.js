/* Pay Tracker (LocalStorage, Stage 2)
   - Add / edit / delete shifts
   - Scheduled vs actual hours + pay
   - Weekly summary (Mon–Sun)
   - Payment date = Friday of following week (weekEnd Sunday + 5 days)
   - Export/Import JSON
*/

const LS_KEY = "paytracker_shifts_v1";

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

const formErrorEl = document.getElementById("formError");

const submitBtn = document.getElementById("submitBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");

const shiftsTbody = document.getElementById("shiftsTbody");
const weeksWrap = document.getElementById("weeksWrap");

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

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

function minsWorked(startTime, endTime, breakMins) {
	const s = timeToMins(startTime);
	const e = timeToMins(endTime);
	if (s == null || e == null) return null;

	let dur = e - s;
	if (dur < 0) dur += 24 * 60; // overnight shift

	dur -= safeNumber(breakMins, 0);
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

// --------- Storage ----------
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
	const schedMins = minsWorked(input.schedStart, input.schedEnd, input.schedBreakMins);
	if (schedMins != null && schedMins <= 0) errors.push("Scheduled hours look invalid (break may be too long).");

	// sanity check: actual minutes after break > 0 (only if provided)
	if (hasActualStart && hasActualEnd) {
		const actMins = minsWorked(input.actStart, input.actEnd, input.actBreakMins ?? 0);
		if (actMins != null && actMins <= 0) errors.push("Actual hours look invalid (break may be too long).");
	}

	return errors;
}

// --------- Calculations ----------
function calcForShift(shift) {
	const rate = safeNumber(shift.rate, 0);

	const schedMins = minsWorked(shift.sched.start, shift.sched.end, shift.sched.breakMins);
	const schedHours = schedMins == null ? 0 : minsToHours(schedMins);
	const schedPay = schedHours * rate;

	let actHours = 0;
	let actPay = 0;

	if (shift.actual && shift.actual.start && shift.actual.end) {
		const actMins = minsWorked(shift.actual.start, shift.actual.end, shift.actual.breakMins ?? 0);
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

function getWeekIdForDateStr(dateStr) {
	const d = parseISODate(dateStr);
	const ws = getWeekStart(d);
	return dateKey(ws);
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
	// sort shifts by date descending, then creation time if you add it later
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
	// keep nice defaults
	schedBreakEl.value = "0";
	actBreakEl.value = "0";
	editingId = null;
	submitBtn.textContent = "Add shift";
	cancelEditBtn.hidden = true;
	clearError();
}

function fillFormFromShift(shift) {
	dateWorkedEl.value = shift.dateWorked;
	hourlyRateEl.value = shift.rate;
	notesEl.value = shift.notes ?? "";

	schedStartEl.value = shift.sched.start;
	schedEndEl.value = shift.sched.end;
	schedBreakEl.value = shift.sched.breakMins ?? 0;

	actStartEl.value = shift.actual?.start ?? "";
	actEndEl.value = shift.actual?.end ?? "";
	actBreakEl.value = shift.actual?.breakMins ?? 0;
}

// --------- Actions ----------
function addShiftFromInput(input) {
	const shift = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		dateWorked: input.dateWorked,
		rate: input.rate,
		notes: input.notes,
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
	saveLocal();
	render();
	resetForm();
}

function updateShiftFromInput(id, input) {
	const idx = shifts.findIndex(s => s.id === id);
	if (idx === -1) return;

	const updated = {
		...shifts[idx],
		dateWorked: input.dateWorked,
		rate: input.rate,
		notes: input.notes,
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
	saveLocal();
	render();
	resetForm();
}

function startEdit(id) {
	const s = shifts.find(x => x.id === id);
	if (!s) return;

	editingId = id;
	fillFormFromShift(s);
	submitBtn.textContent = "Save changes";
	cancelEditBtn.hidden = false;
	clearError();

	// scroll form into view for convenience
	form.scrollIntoView({ behaviour: "smooth", block: "start" });
}

function onDelete(id) {
	const s = shifts.find(x => x.id === id);
	if (!s) return;

	const ok = confirm(`Delete shift on ${s.dateWorked}?`);
	if (!ok) return;

	shifts = shifts.filter(x => x.id !== id);
	saveLocal();
	render();

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
	downloadText(`paytracker_export_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(payload, null, 2));
}

async function importJSONFile(file) {
	const text = await file.text();
	const parsed = JSON.parse(text);

	const incoming = Array.isArray(parsed) ? parsed : parsed.shifts;
	if (!Array.isArray(incoming)) throw new Error("Invalid JSON format.");

	// basic sanity filtering
	const cleaned = incoming
		.filter(s => s && typeof s === "object" && typeof s.id === "string" && typeof s.dateWorked === "string")
		.map(s => ({
			id: s.id,
			createdAt: s.createdAt ?? Date.now(),
			dateWorked: s.dateWorked,
			rate: safeNumber(s.rate, 0),
			notes: s.notes ?? "",
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

	// Replace (simplest). You can change to merge later.
	shifts = cleaned;
	saveLocal();
	render();
	resetForm();
}

// --------- Events ----------
form.addEventListener("submit", (e) => {
	e.preventDefault();
	clearError();

	const input = getFormInput();
	const errs = validateShiftInput(input);
	if (errs.length) {
		setError(errs[0]);
		return;
	}

	if (editingId == null) addShiftFromInput(input);
	else updateShiftFromInput(editingId, input);
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

// --------- Init ----------
function init() {
	shifts = loadLocal();
	render();
}
init();