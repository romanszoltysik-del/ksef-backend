const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const KSEF_API = "https://ksef.mf.gov.pl/api";
const TOKEN = process.env.KSEF_TOKEN;
const NIP = process.env.KSEF_NIP;

async function ksefFetch(path, options = {}) {
  const url = `${KSEF_API}${path}`;
  console.log("KSeF request:", options.method || "GET", url);
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  console.log("KSeF response status:", res.status);
  console.log("KSeF response body (first 500):", text.substring(0, 500));
  if (!res.ok) throw new Error(`KSeF ${res.status}: ${text.substring(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`KSeF zwrócił HTML zamiast JSON: ${text.substring(0, 200)}`);
  }
}

async function openSession() {
  const body = {
    contextIdentifier: { type: "onip", identifier: NIP },
    authorisationToken: TOKEN,
  };
  const data = await ksefFetch("/online/Session/AuthorisedWithToken", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.sessionToken.token;
}

async function closeSession(sessionToken) {
  try {
    await ksefFetch("/online/Session/Terminate", {
      method: "GET",
      headers: { "SessionToken": sessionToken },
    });
  } catch(e) { console.log("closeSession error (ignored):", e.message); }
}

app.get("/faktury", async (req, res) => {
  const { typ = "otrzymane", od, do: doDate } = req.query;
  const now = new Date();
  const dateFrom = od || `${now.getFullYear()}-01-01`;
  const dateTo = doDate || now.toISOString().split("T")[0];
  const subjectType = typ === "wystawione" ? "subject1" : "subject3";

  let sessionToken;
  try {
    sessionToken = await openSession();

    const queryBody = {
      queryCriteria: {
        subjectType,
        dateRange: {
          startDate: `${dateFrom}T00:00:00.000Z`,
          endDate: `${dateTo}T23:59:59.000Z`,
        },
      },
    };

    const queryResult = await ksefFetch("/online/Invoice/Query/sync", {
      method: "POST",
      headers: { "SessionToken": sessionToken },
      body: JSON.stringify(queryBody),
    });

    const faktury = (queryResult.invoiceHeaderList || []).map(inv => ({
      id: inv.invoiceReferenceNumber || inv.ksefReferenceNumber,
      ksefId: inv.ksefReferenceNumber,
      nip: inv.subjectBy?.issuedToIdentifier?.identifier || "",
      firma: inv.subjectBy?.issuedToName?.tradeName || inv.subjectBy?.issuedToName?.fullName || "–",
      kwota: parseFloat(inv.gross || inv.net || 0),
      data: inv.invoicingDate?.split("T")[0] || "",
      termin: inv.paymentDate?.split("T")[0] || "",
      status: "niezapłacona",
      waluta: inv.currency || "PLN",
    }));

    await closeSession(sessionToken);
    res.json({ ok: true, faktury });

  } catch (err) {
    if (sessionToken) await closeSession(sessionToken);
    console.error("ERROR:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnostyczny endpoint - pokaż dokładny błąd z KSeF
app.get("/test-sesja", async (req, res) => {
  try {
    const body = {
      contextIdentifier: { type: "onip", identifier: NIP },
      authorisationToken: TOKEN,
    };
    const url = `${KSEF_API}/online/Session/AuthorisedWithToken`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    res.json({ status: r.status, nip: NIP, tokenLength: TOKEN?.length, body: text.substring(0, 1000) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", info: "KSeF Proxy API v2" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`KSeF backend port ${PORT}`));
