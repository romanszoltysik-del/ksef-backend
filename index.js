const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const KSEF_API = "https://ksef.mf.gov.pl/api";
const TOKEN = process.env.KSEF_TOKEN;
const NIP = process.env.KSEF_NIP;

// Pomocnicza funkcja do zapytań do KSeF
async function ksefFetch(path, options = {}) {
  const res = await fetch(`${KSEF_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`KSeF error ${res.status}: ${txt}`);
  }
  return res.json();
}

// Otwórz sesję z tokenem
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

// Zamknij sesję
async function closeSession(sessionToken) {
  await ksefFetch("/online/Session/Terminate", {
    method: "GET",
    headers: { "SessionToken": sessionToken },
  }).catch(() => {});
}

// GET /faktury?typ=otrzymane|wystawione&od=2026-01-01&do=2026-12-31
app.get("/faktury", async (req, res) => {
  const { typ = "otrzymane", od, do: doDate } = req.query;

  // Daty domyślne: bieżący rok
  const now = new Date();
  const dateFrom = od || `${now.getFullYear()}-01-01`;
  const dateTo = doDate || now.toISOString().split("T")[0];

  // Kierunek: 1 = otrzymane, 2 = wystawione
  const subjectType = typ === "wystawione" ? "subject1" : "subject3";

  let sessionToken;
  try {
    sessionToken = await openSession();

    // Inicjuj zapytanie o faktury
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

    // Zbierz faktury z odpowiedzi
    const faktury = (queryResult.invoiceHeaderList || []).map(inv => ({
      id: inv.invoiceReferenceNumber || inv.ksefReferenceNumber,
      ksefId: inv.ksefReferenceNumber,
      nip: inv.subjectBy?.issuedToIdentifier?.identifier || "",
      firma: inv.subjectBy?.issuedToName?.tradeName || inv.subjectBy?.issuedToName?.fullName || "–",
      kwota: parseFloat(inv.gross || inv.net || 0),
      data: inv.invoicingDate?.split("T")[0] || "",
      termin: inv.paymentDate?.split("T")[0] || "",
      status: "niezapłacona", // KSeF nie zwraca statusu płatności – trzeba śledzić samodzielnie
      waluta: inv.currency || "PLN",
    }));

    await closeSession(sessionToken);
    res.json({ ok: true, faktury });

  } catch (err) {
    if (sessionToken) await closeSession(sessionToken);
    console.error(err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", info: "KSeF Proxy API" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`KSeF backend działa na porcie ${PORT}`));
