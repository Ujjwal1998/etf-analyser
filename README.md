# ETF Portfolio Analyser

A local-first Next.js dashboard for analysing ETF portfolios exported from Trading 212 and similar brokers.

The portfolio file is parsed in the browser and stored in local browser storage. Transaction data is not uploaded. Market-data requests are made through local Next.js route handlers using instrument identifiers only.

## Features

- Import Trading 212 CSV or XLSX exports.
- Transaction totals and conversion fees must be in GBP. Other account currencies are rejected rather than mixed into pound values.
- Track invested amount, current value, cash, and total return.
- Show open positions with latest end-of-day prices.
- Combine ETF constituents across the portfolio and rank the aggregate top 10 holdings.
- Compare portfolio performance with the S&P 500, FTSE 100, and Nasdaq-100.
- Switch benchmark tables between return, annualised volatility, maximum drawdown, and downside deviation.
- Display position and look-through allocation donuts.
- Cache end-of-day market history locally for 20 hours.

## Requirements

- Node.js 20+
- npm
- An Alpha Vantage API key for the historical-data fallback.

## Setup

```bash
npm install
```

Create `.env.local` and add:

```env
ALPHA_VANTAGE_API_KEY=your_key_here
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Data sources

- ETF prices and historical ETF series: justETF where available.
- Shares and indices: Yahoo Finance where available, with Nasdaq used for USD share quotes.
- Historical USD prices are converted with dated GBP/USD rates. London prices quoted in pence are converted to pounds.
- Fallback historical data: Alpha Vantage.
- ETF constituents: issuer/justETF-backed server route.

The application stores imported transactions, quotes, benchmark history, and constituent snapshots in browser local storage. Use “Delete local data” in the dashboard to remove the stored portfolio from that browser.

Use “Refresh market data” to retry failed requests or refresh snapshots older than 20 hours. Historical performance includes sold positions, dividends and taxes. Comparisons are only shown for periods with sufficient priced history.

## Development commands

```bash
npm run dev       # start the development server
npm run lint      # run ESLint
npm test          # run Vitest tests
npm run build     # create a production build
```

## Notes

Portfolio benchmark performance is time-weighted so deposits and withdrawals do not inflate the comparison. Risk metrics are calculated from the available daily historical series; periods without sufficient portfolio history are shown as unavailable rather than extrapolated.

This project is intended for personal analysis and is not financial advice.
