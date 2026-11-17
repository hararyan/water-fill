import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db, isConfigured } from "./firebase.js";

const STAFF_PIN = import.meta.env.VITE_STAFF_PIN || "";

function useRequests() {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }
    const q = query(collection(db, "refillRequests"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(
      q,
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
  }, []);

  return { requests, error, loading };
}

function timeAgo(ts) {
  if (!ts?.toMillis) return "just now";
  const mins = Math.floor((Date.now() - ts.toMillis()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return ts.toDate().toLocaleDateString();
}

function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
}

function RequestView({ requests, loading }) {
  const [location, setLocation] = useState(() => localStorage.getItem("wr_location") || "");
  const [name, setName] = useState(() => localStorage.getItem("wr_name") || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useTick();

  const pending = useMemo(() => requests.filter((r) => r.status === "pending"), [requests]);
  const lastDone = requests.find((r) => r.status === "done");
  const trimmed = location.trim();
  const alreadyPending = pending.find((r) => r.location.toLowerCase() === trimmed.toLowerCase());

  async function submit(e) {
    e.preventDefault();
    if (!trimmed || alreadyPending) return;
    setBusy(true);
    setMsg("");
    try {
      localStorage.setItem("wr_location", trimmed);
      localStorage.setItem("wr_name", name.trim());
      await addDoc(collection(db, "refillRequests"), {
        location: trimmed.slice(0, 60),
        requestedBy: name.trim().slice(0, 40),
        status: "pending",
        createdAt: serverTimestamp(),
      });
      setMsg("Request sent. The refill person has been alerted.");
    } catch (err) {
      setMsg("Could not send: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Water can empty?</h2>
      <p className="muted">Tell the refill person where it is. They'll mark it done once replaced.</p>

      <form onSubmit={submit}>
        <label>
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. 3rd floor pantry"
            maxLength={60}
            required
          />
        </label>
        <label>
          Your name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aryan" maxLength={40} />
        </label>
        <button className="primary big" disabled={busy || !trimmed || !!alreadyPending}>
          {alreadyPending ? "Already requested" : busy ? "Sending…" : "💧 Request refill"}
        </button>
      </form>

      {alreadyPending && (
        <div className="notice pending">
          Waiting for refill at <b>{alreadyPending.location}</b> — requested {timeAgo(alreadyPending.createdAt)}.
        </div>
      )}
      {msg && <div className="notice">{msg}</div>}

      <h3>Current status</h3>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="ok">✅ No pending requests.</p>
      ) : (
        <ul className="list">
          {pending.map((r) => (
            <li key={r.id}>
              <span>
                <b>{r.location}</b>
                {r.requestedBy ? ` · ${r.requestedBy}` : ""}
              </span>
              <span className="muted">{timeAgo(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {lastDone && <p className="muted small">Last refill: {lastDone.location}, {timeAgo(lastDone.doneAt)}</p>}
    </section>
  );
}

function StaffView({ requests, loading }) {
  const [unlocked, setUnlocked] = useState(!STAFF_PIN || sessionStorage.getItem("wr_staff") === "1");
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [notifOn, setNotifOn] = useState(
    typeof Notification !== "undefined" && Notification.permission === "granted"
  );
  const seen = useRef(null);
  useTick();

  const pending = requests.filter((r) => r.status === "pending");
  const done = requests.filter((r) => r.status === "done").slice(0, 10);

  // Alert staff when a new request arrives
  useEffect(() => {
    if (!unlocked || loading) return;
    const ids = new Set(pending.map((r) => r.id));
    if (seen.current) {
      const fresh = pending.filter((r) => !seen.current.has(r.id));
      if (fresh.length) {
        navigator.vibrate?.([200, 100, 200]);
        if (notifOn && document.hidden) {
          new Notification("💧 Water refill needed", { body: fresh.map((r) => r.location).join(", ") });
        }
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const o = ctx.createOscillator();
          o.connect(ctx.destination);
          o.frequency.value = 880;
          o.start();
          o.stop(ctx.currentTime + 0.25);
        } catch {}
      }
    }
    seen.current = ids;
  }, [pending.map((r) => r.id).join(","), unlocked, loading, notifOn]);

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Water Refill` : "Water Refill";
  }, [pending.length]);

  function unlock(e) {
    e.preventDefault();
    if (pin === STAFF_PIN) {
      sessionStorage.setItem("wr_staff", "1");
      setUnlocked(true);
    } else setPinErr(true);
  }

  async function enableNotif() {
    if (typeof Notification === "undefined") return alert("Notifications are not supported on this browser.");
    const p = await Notification.requestPermission();
    setNotifOn(p === "granted");
  }

  async function markDone(id) {
    try {
      await updateDoc(doc(db, "refillRequests", id), { status: "done", doneAt: serverTimestamp() });
    } catch (err) {
      alert("Could not update: " + err.message);
    }
  }

  if (!unlocked) {
    return (
      <section className="card">
        <h2>Refill staff</h2>
        <form onSubmit={unlock}>
          <label>
            Enter PIN
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setPinErr(false);
              }}
              autoFocus
            />
          </label>
          {pinErr && <div className="notice error">Wrong PIN</div>}
          <button className="primary big">Open</button>
        </form>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>
        Pending refills <span className="badge">{pending.length}</span>
      </h2>
      {!notifOn && (
        <button className="ghost" onClick={enableNotif}>
          🔔 Enable alerts
        </button>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="ok">✅ All cans are full.</p>
      ) : (
        <ul className="list big">
          {pending.map((r) => (
            <li key={r.id}>
              <span>
                <b>{r.location}</b>
                <br />
                <span className="muted small">
                  {r.requestedBy ? `${r.requestedBy} · ` : ""}
                  {timeAgo(r.createdAt)}
                </span>
              </span>
              <button className="primary" onClick={() => markDone(r.id)}>
                ✔ Done
              </button>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <>
          <h3>Recently done</h3>
          <ul className="list">
            {done.map((r) => (
              <li key={r.id} className="faded">
                <span>{r.location}</span>
                <span className="muted">{timeAgo(r.doneAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState(location.hash === "#staff" ? "staff" : "request");
  const { requests, error, loading } = useRequests();

  useEffect(() => {
    location.hash = tab === "staff" ? "staff" : "";
  }, [tab]);

  return (
    <div className="app">
      <header>
        <h1>💧 Water Refill</h1>
        <nav>
          <button className={tab === "request" ? "active" : ""} onClick={() => setTab("request")}>
            Request
          </button>
          <button className={tab === "staff" ? "active" : ""} onClick={() => setTab("staff")}>
            Refill staff
          </button>
        </nav>
      </header>

      {!isConfigured && (
        <div className="notice error">
          Firebase isn't configured. Copy <code>.env.example</code> to <code>.env</code> and fill in your Firebase
          keys (see README).
        </div>
      )}
      {error && <div className="notice error">Database error: {error}</div>}

      {tab === "request" ? (
        <RequestView requests={requests} loading={loading} />
      ) : (
        <StaffView requests={requests} loading={loading} />
      )}
    </div>
  );
}
