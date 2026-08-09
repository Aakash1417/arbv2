# LoL arbitrage scanner

Finds arbitrage on **League of Legends** markets — player props *and* match-level
markets — by comparing sportsbooks against each other.

| book | status |
| --- | --- |
| Betway (en-CA) | working — direct |
| BET99 | working — direct |
| Ozoon | working — direct |
| bet365 | working — Selenium scrape, incl. **player props** (see [bet365](#bet365)) |

The pipeline is N-book: fixtures cluster across any number of books and a market
is comparable as soon as two of them price it — including fixtures or markets
the first book doesn't carry.

Three books expose their prices over plain public endpoints and need nothing
installed. bet365 has no usable API and is scraped with Selenium into a
snapshot the scan reads. Node 18+ (Ozoon needs Node 22's built-in `WebSocket`,
or Node 18/20 run with `--experimental-websocket`).

```bash
node find-arbs.js
```

## Usage

```bash
node find-arbs.js                        # every market, LPL/LCK/LCS, next 24h
node find-arbs.js --players              # player props only
node find-arbs.js --markets match_winner,map_kills_handicap
node find-arbs.js --list-markets         # what can be compared
node find-arbs.js --list-books           # books and their status
node find-arbs.js --books betway,bet99   # restrict to specific books
node find-arbs.js --hours 6              # only fixtures starting soon
node find-arbs.js --min-roi 0            # show every edge (default floor is 2%)
node find-arbs.js --leagues LPL,LCK      # restrict to specific leagues
node find-arbs.js --bankroll 500         # size the worked stake example
node find-arbs.js --watch 60             # rescan every 60s
node find-arbs.js --json out.json -v     # dump raw results + diagnostics
node tools/bet365-scrape.js              # refresh the bet365 snapshot
npm test                                 # 55 unit tests over the math + parsers
```

## Leagues

Eleven competitions are tracked, listed in `src/leagues.js`:

`LPL` · `LCK` · `LCS` · `LEC` · `LCP` · `CBLOL` · `LCK CL` · `LES` · `LRN` ·
`LRS` · `PRIME LEAGUE`

Books disagree on naming in two ways, and both are reconciled there: season
decoration (`LPL Split 3`, `LEC Summer`) is stripped, and different names for
the same competition are aliased onto one key — BET99's
`LCK Challengers League` is Betway's and Ozoon's `LCK CL`. `LCK CL` is
deliberately *not* folded into `LCK`; they are different competitions.

Betway is queried by group slug (`lck-cl`, `prime-league`), the other books by
league name, so the registry holds both. Competitions only one book prices are
left out — they can never produce a cross-book arb.

## Markets compared

| family | level | shape |
| --- | --- | --- |
| `match_winner`, `correct_score` | series | categorical |
| `maps_handicap`, `total_maps` | series | line |
| `match_kills_handicap`, `match_total_kills` | series | line |
| `win_at_least_one_map` | series, per team | categorical |
| `map_winner`, `first_blood`, `first_inhibitor`, `first_baron` | per map | categorical |
| `map_kills_odd_even`, `race_to_10_kills` | per map | categorical |
| `map_total_kills`, `map_total_barons` | per map | line |
| `map_total_towers`, `map_total_dragons` | per map | line |
| `map_kills_handicap`, `map_towers_handicap`, `map_dragons_handicap` | per map | line |
| `team_total_kills` | per map, per team | line |
| `player_kills`, `player_deaths`, `player_assists` | per map, per player | line |

A market needs only **two** books, not all of them — `map_total_towers` and
`map_total_dragons` pair BET99 against Ozoon with Betway absent, and
`race_to_10_kills` pairs Betway against Ozoon with BET99 absent.

Markets only one book prices are still left out rather than guessed at (Betway's
game-time and winner-&-total combos, BET99's most-X and 3-way markets, Ozoon's
first-dragon-type and map-exacta). Naming across books is not a reliable key:
Betway can't tell a team total from a player total by wording alone
("Map 1 Bilibili Gaming Total Kills" vs "Map 1 - Total Kills - knight"), and on
BET99 the two are worded identically — only the market `type` (`TEAMTKOU` vs
`PLAYTKOU`) separates them. Ozoon calls dragons what BET99 calls drakes, and
buries towers, dragons and barons inside a single "Map Totals" market whose
family is decided per outcome.

Player props only appear roughly **2–3 hours before a match** (about a day out
on bet365), so an empty scan usually just means nothing is priced yet. Run with
`--watch` to catch them as they open.

Output is filtered to edges of **2% or better** by default, since thinner ones
rarely survive the time it takes to place both legs. `--min-roi 0` shows
everything.

## What it reports

An arb exists whenever a set of legs covers every possible result and their
implied probabilities sum to under 1. Two market shapes, one test.

**Line markets** (totals, handicaps, player props) reduce to two thresholds:

- **Exact** — `X > t` and `X < t` at the same `t`, different books. Exactly one
  leg wins.
- **Middle** — `X > t1` and `X < t2` with `t2 > t1`. Half-point lines mean every
  result is still covered, so the same test holds, and anything strictly between
  the two lines wins *both*. Flagged `MIDDLE` with the winning range.

The reverse pairing (`X < t1` with `X > t2`) leaves a gap where both legs lose
and is never reported.

Handicaps fold into the same machinery: backing the home side at −7.5 wins when
the home-minus-away margin clears 7.5, and the away side at +7.5 wins when it
doesn't — so both become thresholds on the same quantity. That is what lets a
handicap at one line be compared against the other side at a different line, and
it is where handicap middles come from.

**Categorical markets** (winner, correct score, odd/even, yes/no) take the best
price for each distinct outcome and apply the same sum. The outcome set is the
union of what the books quote, so a book that omits an outcome can't turn a
losing position into a phantom arb. Four-way correct-score arbs print as
`4-WAY`.

Prices are shown in **American odds** with the decimal in brackets, and each leg
links straight to the page you place it on — Betway deep-links to the specific
market-group tab, BET99 to the fixture page.

Sample output:

```
   6.60%  EXACT  JackeyLove Player Total Kills · Map 1
          LPL — Bilibili Gaming - Top  (2026-08-07 11:00Z)
          OVER  4.5    +175 (2.750)  on betway  stake $38.76
          UNDER 4.5    -135 (1.741)  on bet99   stake $61.24
          $100 staked -> $106.6 back, profit $6.6
          betway -> https://betway.com/g/en-ca/sports/event/17033494?marketGroup=map-1---player-specials
          bet99  -> https://bet99.com/en/esports/e_league_of_legends/lpl/lpl-split-3-2026/bilibili-gaming-vs-top-esports/4970487
```

The JSON dump (`--json`) carries both formats: `legs.over.odds` is decimal,
`legs.over.american` is the integer moneyline.

## How the data is obtained

The three direct books were reverse-engineered from their own front-ends; those
endpoints are public and unauthenticated. bet365 has no usable API and is
scraped from the rendered site instead.

### Betway — `src/books/betway.js`

`POST https://betway.com/g/api/sports/content/getGroup`
→ event ids + start times for one league.

`POST https://betway.com/g/api/sports/content/getEventDetails`
→ every `Markets[]` / `Outcomes[]` for one event, with `OddsDecimal`.

Both require the full brand/territory envelope (`BrandId 3`, `LanguageId 25`,
`TerritoryId 38`, `JurisdictionId 2`, …). Without it the gateway replies
`ERR_NO_ROUTING_TARGET`. Player props sit in the `Map N - Player Specials`
market group, titled `Map 1 - Total Kills - <player>`.

### BET99 — `src/books/bet99.js`

`POST https://bet99.com/java-graphql/graphql`, `betSync` query (Amelco
platform). One call returns the LoL sport tree (category → competition), a
second returns events, a third returns `markets { … selection { odds } }` for a
batch of event ids.

Introspection is disabled, so the selection sets are the ones the site itself
ships. Player props are the markets typed `E_LEAGUE_OF_LEGENDS:P:PLAYTKOU`,
named `<player> Total Kills Over/Under 2.5 (Map 1)`.

Note the live price socket (`wss://bet99.com/graphql-ws`) rejects non-browser
clients with a 403, but `selection.odds` on the HTTP query carries the same
decimal prices — polling is enough.

Fixture links are rebuilt as
`/en/esports/e_league_of_legends/{category}/{competition}/{fixture}/{eventId}`.
The router resolves the event from the trailing id, so the three slugs are
cosmetic and a wording drift still lands on the right page.

### Ozoon — `src/books/ozoon.js`

One public WebSocket carries everything — no auth, no Cloudflare challenge:

```
wss://services.ozoon.eu/services/sports/subscription/<uuid>?language=en&lnGrp=2
```

The `<uuid>` is client-generated. The protocol is plain text — `SUBSCRIBE|A|<path>`
out, `<json header>|<json body>` back — and two subscription shapes are used:

- `/competitions/117310?…&preMatchOnly=true` — the LoL tree: leagues, fixtures,
  start times and competitors with home/away flags.
- `/eventByLink/$esports$league-of-legends$lck$…` — one fixture's full market
  book. The site path with `/` swapped for `$`.

A whole scan runs over a single socket: every subscription is fired at once and
the feed is read until it goes quiet. Responses are bracketed by
`*_catchup_start` / `*_catchup_end`, but silence is the real terminator — a path
matching nothing replies with an immediate empty start/end pair, so waiting for
quiet lets a partly-bad batch still return everything that did arrive.

Two wrinkles worth knowing:

- Each fixture arrives as **two** `fullEvent` frames, `main` and `alternate`,
  which have to be merged — the alternate frame is where the player props and
  alternate lines live, and it is ~13× the size of the main one.
- Prices come as `{american, decimal, fractional}`. Decimal is used as the
  source of truth so every book converts identically.

League names carry season decoration (`LPL Split 3`, `LCS Summer`) which is
stripped for matching — but not so far that `LCK CL` collapses into `LCK`, since
those are different competitions.

### bet365 — `tools/bet365-scrape.js` + `src/books/bet365.js`

bet365 has **no usable API**. Its origin answers `200 OK` with a zero-byte body
for every odds endpoint under automation; the only content that arrives comes
from Cloudflare's shared cache, and the headers make the split obvious:

```
/leftnavcontentapi/allsportsmenu   200   12278 bytes   cf-cache-status: HIT
/splashcontentapi/splash           200       0 bytes   cf-cache-status: DYNAMIC
```

What *does* work is **a visible Chrome driven by Selenium**. The site renders
normally there and the DOM can be read directly. Three quirks shape the scraper:

- **Headless is refused.** Measured: `--headless=new` and the old mode both sit
  at a 687-byte shell with zero fixtures for 100s+, and a reload does not rescue
  it. Headed gets all 48 fixtures in ~25s. This is the same wall Playwright hits.
  `--headless` is kept only so the claim can be re-checked.
- **Navigation needs an explicit reload.** Every route is a hash change, which
  the browser treats as same-document — the URL updates but nothing repaints,
  and `driver.get()` on a hash-only difference is a no-op. Click (or `get`) to
  set the hash, then `refresh()`. That one call is the difference between a
  blank page and a full market book.
- **Player props sit behind a "Player" tab** (route suffix `/I11/`) — same
  click-then-refresh dance.

Because a click never unloads the coupon document, `back()` restores it
instantly, so every fixture's route is harvested in one pass (~3.5s each) before
any event page is loaded.

Scraping is ~35s per fixture, so it runs separately and writes
`data/bet365.json`; the scan just reads that snapshot and ignores it once it is
older than two hours. **Leave the browser window alone while it runs.**

```bash
node tools/bet365-scrape.js --hours 24
```

**LPL is skipped** — bet365 prices no LoL player props for it. Fixtures inside
about a day carry `Map N - Player Total Kills / Deaths / Assists` (a recent run:
4 of 6 fixtures, the two without being further out), plus match lines, per-map
winners, kill/tower/dragon handicaps, map totals and
first-blood/baron/inhibitor.

bet365 renders markets as a **grid**: one column holds the row labels (player or
team names) and the remaining columns hold prices, aligned to those labels *by
index*. All the mapping is therefore index alignment, and a column whose length
disagrees with the labels is dropped rather than zipped — a shifted grid would
otherwise hand one player another player's price.

Player matchups (`Siwoo v PerfecT`), rift-herald and tower-destroy markets are
left unmapped: no other book prices them.

## Layout

| file | role |
| --- | --- |
| `find-arbs.js` | CLI: flags, formatting, watch loop |
| `src/scan.js` | one full pass: fetch → cluster → group → price |
| `src/markets.js` | canonical market taxonomy + threshold conversion |
| `src/books/index.js` | book registry, in priority order |
| `src/books/betway.js` | Betway client + market classification |
| `src/books/bet99.js` | BET99 GraphQL client + market classification |
| `src/books/ozoon.js` | Ozoon market classification |
| `src/books/ozoon-feed.js` | Ozoon WebSocket feed client |
| `src/books/bet365.js` | normalises the bet365 snapshot, with a staleness guard |
| `tools/bet365-scrape.js` | Selenium collector -> `data/bet365.json` |
| `tools/bet365-dom.js` | browser-side extraction for bet365's market grid |
| `src/match.js` | clusters fixtures across books, resolves them into one home/away frame, groups markets |
| `src/arb.js` | arb/middle detection and stake sizing |

## Adding a book

Implement `collect({ leagues, withinMs, onWarn })` returning `{ events, quotes }`
in the shapes `markets.js` documents, then add it to `src/books/index.js`. The
scan, fixture clustering, market grouping and arb engine are all N-book already —
nothing else changes. Position in the registry is priority order: the first book
carrying a fixture defines its canonical home/away frame, and every other book's
outcomes are resolved onto it by team name.
| `src/normalize.js` | team/player/stat normalisation shared by both books |
| `src/odds.js` | decimal ↔ American odds conversion |
| `src/http.js` | retrying JSON POST + bounded-concurrency helper |

## Caveats

- **Odds move.** Everything reported is a snapshot from the moment of the scan.
  Verify both prices in the books before staking, and place the thinner-liquidity
  leg first.
- Betway lists player specials for Maps 1–3 but keeps the later maps
  **suspended** until the series is under way, so pre-match only Map 1 is
  actually priced on both books. Suspended markets are dropped, which is why
  scans read `Map 1` throughout; Maps 2–3 start matching once they open.
- Fixtures are paired on normalised team names plus a ±3h start-time window.
  Team names match on whole tokens, never as raw substrings — `Team WE` ("we")
  and `Weibo Gaming` ("weibo") are different LPL orgs.
- **Player handles must match exactly** once normalised. LPL fields both a
  `Wei` and a `Weiwei` in the same fixture, and any prefix rule pairs one
  player's Over with the other's Under and reports a large phantom arb. The only
  decoration books actually add is a real name in parentheses
  (`Ahn (An Shan-Ye)` ↔ `Ahn`), which is stripped before comparison, so exact
  matching loses nothing real. Unmatched handles are skipped, not guessed.
- Betway's orientation is the canonical home/away frame for a fixture; BET99's
  outcomes are resolved onto it **by team name**, not by position, so a book
  that lists the teams the other way round still lines up. A team name that
  matches both sides or neither is dropped rather than assumed.
- In practice the edges live in player props. Match-level markets are priced
  far more tightly — a typical three-book scan shows player props around 0.94
  implied sum against 1.01–1.10 for winners, handicaps and totals — so expect
  match-level arbs to be rare and short-lived.
- Stake limits, price changes on bet acceptance, and account restrictions are not
  modelled.
