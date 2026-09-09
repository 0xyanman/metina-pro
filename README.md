# Metina PRO TP/SL (24h)

24/7 take-profit / stop-loss worker for [Metina Pro](https://pro.metina.id), plus **Telegram `/open`** to mint an LP. You run it on **your** machine or VPS. Metina Pro **does not store your private key**.

---

## English

Small worker that members run on their own computer / VPS.

The key lives only in your `.env` on that machine. This replaces the desk tab that had to stay open.

**Two jobs:**

1. **Watch + close** — set SL/TP on the Metina Pro Open positions card (or pass them on `/open`). The worker checks every ~45s and closes when a level is hit.
2. **Open an LP from Telegram** — `/open` looks up the pool and mints through Metina Pro, same as the desk Open button. EVM only (`0x` token). Telegram must be enabled.

### Before you start

1. An active [Metina Pro](https://pro.metina.id) account (email + password).
2. Vault / LP wallet private key (`0x` + 64 hex chars).
3. The same RPC URLs as Metina Settings (BSC / Base / Robinhood). Settings keeps them in the browser only — copy them into `.env`. Fill every chain you have positions on.
4. Node 18+ if you run it on your laptop. Or a Railway / VPS account if you want 24h without leaving a laptop on.
5. On the Pro desk: open **Open positions**, fill **SL** and **TP** on each card you want protected. Empty SL/TP = the worker will not close that position.

`LIVE_CLOSE=0` means **watch only**. The worker logs `DRY stop loss …` and does not send a close. Telegram `/close` is also ignored. `LIVE_CLOSE=1` actually closes + swaps, same as the Close button.

`LIVE_OPEN=0` means Telegram `/open` only looks up the pool (same as Confirm on the desk, without minting). `LIVE_OPEN=1` actually mints via `/api/web/deploy`.

**Do not use Vercel.** `npm start` is a long-running loop; Vercel kills it. Hobby cron is once a day.

### A. Laptop (test first)

```bash
git clone https://github.com/0xyanman/metina-tpsl.git
cd metina-tpsl
cp .env.example .env
```

Edit `.env` (never commit this file):

```
METINA_URL=https://pro.metina.id
METINA_EMAIL=you@email.com
METINA_PASSWORD=your-pro-password
EVM_PRIVATE_KEY=0xyourkey
RPC_BSC=https://…
RPC_BASE=https://…
RPC_ROBINHOOD=https://…
LIVE_CLOSE=0
LIVE_OPEN=0
```

```bash
npm install
npm start
```

Leave the terminal open. Every ~45s you should see:

```
logged in as you@email.com wallet 0x…
LIVE_CLOSE=0 — watch only. Set LIVE_CLOSE=1 in .env to close.
LIVE_OPEN=0 — /open lookup only. Set LIVE_OPEN=1 in .env to mint.
watch 2 open · hits 0
```

If a position is past SL/TP you will see `DRY stop loss PAIR …` — still no close.

When that looks right, stop with `Ctrl+C`, set `LIVE_CLOSE=1`, then `npm start` again. Closing the terminal or sleeping the laptop **stops** TP/SL. For 24h, use Railway or a VPS.

### B. Railway (easiest 24h)

1. Open [railway.app](https://railway.app) and sign in with GitHub.
2. **New project** → **Deploy from GitHub repo** → `0xyanman/metina-tpsl`  
   (fork the repo to your GitHub first if you cannot deploy someone else's repo).
3. Open the service → **Variables** and add the same keys as `.env`:
   - `METINA_URL` = `https://pro.metina.id`
   - `METINA_EMAIL`
   - `METINA_PASSWORD`
   - `EVM_PRIVATE_KEY`
   - `RPC_BSC` / `RPC_BASE` / `RPC_ROBINHOOD` (required — every chain you use)
   - `LIVE_CLOSE` = `0`
   - `LIVE_OPEN` = `0`
4. Start command is already `npm start` (`node src/index.js`). No extra build step.
5. Open **Deployments → Logs**. Confirm `logged in` and `watch N open`.
6. When DRY logs look correct, change `LIVE_CLOSE` to `1` and redeploy.

Railway keeps the process up. If the deploy sleeps on a free trial, upgrade or use a VPS.

### C. VPS + pm2 (Ubuntu)

```bash
sudo apt update
sudo apt install -y git nodejs npm
git clone https://github.com/0xyanman/metina-tpsl.git
cd metina-tpsl
cp .env.example .env
nano .env          # fill the same values, start with LIVE_CLOSE=0
npm install
sudo npm install -g pm2
pm2 start src/index.js --name metina-tpsl
pm2 logs metina-tpsl
pm2 startup
pm2 save
```

After DRY logs look correct:

```bash
# in .env set LIVE_CLOSE=1
pm2 restart metina-tpsl
```

```bash
pm2 status          # should stay "online"
pm2 logs metina-tpsl --lines 50
```

### Telegram (optional)

Leave `TELEGRAM_*` empty to keep notifications off.

To enable: create a bot with [@BotFather](https://t.me/BotFather), add it to your chat / group / forum topic, then set in `.env` or Railway Variables:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...                 # chat / group / channel ID
TELEGRAM_MESSAGE_THREAD_ID=          # optional: forum topic
TELEGRAM_ENABLED=1
```

On start you should see `Telegram notifications enabled` and `Telegram command listener started`.

Commands (from that chat only):

- `/refresh` — send the latest open-positions summary
- `/help` — command list
- `/open <0x token> <amount> [chain]` — open an LP via Metina Pro (see below)
- `/close all` — close every open position
- `/close profit` — close only positions currently in profit
- `/close <id>` — close one position (`/close 933596`, or `/close 1` using the number on the last summary card)

`/close` is ignored while `LIVE_CLOSE=0`. `/close` with no target does nothing. Anyone in that chat can send commands.

The worker throttles Telegram so a chat cannot flood Metina Pro: **2s** between any command, **45s** between `/open`, **10s** between `/close`. Extra `/open` while one mint is running is dropped. Pro also rate-limits each worker IP (`/api/web` 60/min, writes like deploy/close 100 per 5 min).

### Open an LP from Telegram

Same path as the Pro desk: `lookup` then `deploy`. The worker does not mint locally.

1. Enable Telegram (section above).
2. Start with `LIVE_OPEN=0`. Send `/open` — you should get `[DRY] Would Open` (pool, amount, range). Nothing is minted.
3. Set `LIVE_OPEN=1` and restart. The same command actually opens the position.

```
/open <0x token> <amount> [chain] [quote] [side] [sl] [tp]
```

```
/open 0xabc… 0.5 robinhood
/open 0xabc… 0.5 robinhood quote=usdg sl=-50 tp=20
/open 0xabc… 0.5 robinhood quote=eth side=single
/open 0xabc… 100 bsc quote=usdt side=double
/open 0xabc… 0.5 base quote=usdc
```

**Amount is in the quote token**, not USD. `0.5 robinhood` = 0.5 USDG. `quote=eth` = 0.5 ETH.

| Chain | Default quote | Other quote |
|---|---|---|
| `robinhood` | `USDG` | `quote=eth` |
| `base` | `USDC` | `quote=eth` |
| `bsc` | `USDT` | `quote=bnb` |

Same quotes as the Pro desk. You can also write the word alone: `/open 0xabc… 100 bsc usdt`.

`side=single`, `side=double`, and `side=token` match the Open LP sides on the Pro desk. You can also write the word alone: `/open 0xabc… 0.5 robinhood double`.

| Side | What it does | Default range |
|---|---|---|
| `single` (default) | Quote-only below spot (USDG / USDT / ETH, no meme until price dumps into range) | `−80% … −1%` |
| `double` | Two-sided · swap meme as needed | `−60% … +150%` |
| `token` | Token-only above spot | `+1% … +150%` |

Picking a side applies that range unless you override with `min=` / `max=`.

| Piece | Default |
|---|---|
| Chain | `auto` (or `robinhood` / `base` / `bsc`) |
| Quote | per chain above (`USDG` / `USDC` / `USDT`) |
| Side | `single` |
| SL / TP | empty (worker will not auto-close until you set them) |

Optional: `min=` / `max=`, `pool=0x…`. Token must be an EVM `0x` address. Solana / DLMM is not supported here (no Solana key in this worker).

If you pass `sl=` / `tp=` on `/open`, the closer uses those levels on the next watch cycle. Otherwise fill SL/TP on the Pro Open card like before.

### Notes

- Stop the worker = TP/SL is off (same as closing the desk tab).
- A position card with empty SL/TP will not close.
- Unreliable on-chain PnL is skipped (avoids a false close).
- The key is sent to Metina **only on close and open (deploy)**, in request memory. It is not saved in the database.
- Settings RPCs live in the member's browser, not the Metina database. The worker must send them from `.env`.
- This folder is a **separate project**. Do not put a member `.env` on the Metina Pro server.

---

## Bahasa Indonesia

Worker kecil yang member jalanin **di komputer / VPS mereka sendiri**.

Metina Pro **tidak menyimpan private key**. Key cuma ada di file `.env` di mesin member. Worker ini pengganti tab desk yang harus tetap kebuka.

**Dua fungsi:**

1. **Pantau + close** — isi SL/TP di kartu Open positions Metina Pro (atau lewat `/open`). Worker ngecek tiap ~45 detik dan nge-close kalau kena.
2. **Buka LP dari Telegram** — `/open` lookup pool lalu mint lewat Metina Pro, sama seperti tombol Open di desk. EVM only (token `0x`). Telegram harus nyala.

### Sebelum mulai

1. Akun [Metina Pro](https://pro.metina.id) yang aktif (email + password).
2. Private key wallet LP (`0x` + 64 karakter hex).
3. RPC yang sama seperti di Settings Metina (BSC / Base / Robinhood). Settings cuma simpan di browser — copy ke `.env`. Isi setiap chain yang ada posisinya.
4. Node 18+ kalau dijalankan di laptop. Atau akun Railway / VPS kalau mau 24 jam tanpa laptop nyala.
5. Di desk Pro: buka **Open positions**, isi **SL** dan **TP** di kartu yang mau dilindungi. SL/TP kosong = worker tidak close posisi itu.

`LIVE_CLOSE=0` artinya **mode lihat dulu**. Worker nulis `DRY stop loss …` dan **tidak** mengirim close. Command Telegram `/close` juga diabaikan. `LIVE_CLOSE=1` baru benar-benar close + swap, sama seperti tombol Close.

`LIVE_OPEN=0` artinya `/open` dari Telegram hanya lookup pool (belum mint). `LIVE_OPEN=1` baru mint lewat `/api/web/deploy`.

**Jangan pakai Vercel.** `npm start` harus hidup terus; Vercel mematikannya. Cron Hobby cuma 1x sehari.

### A. Laptop (tes dulu)

```bash
git clone https://github.com/0xyanman/metina-tpsl.git
cd metina-tpsl
cp .env.example .env
```

Isi `.env` (jangan di-commit):

```
METINA_URL=https://pro.metina.id
METINA_EMAIL=kamu@email.com
METINA_PASSWORD=password-pro
EVM_PRIVATE_KEY=0xkeykamu
RPC_BSC=https://…
RPC_BASE=https://…
RPC_ROBINHOOD=https://…
LIVE_CLOSE=0
LIVE_OPEN=0
```

```bash
npm install
npm start
```

Biarkan terminal terbuka. Tiap ~45 detik harus muncul:

```
logged in as kamu@email.com wallet 0x…
LIVE_CLOSE=0 — watch only. Set LIVE_CLOSE=1 in .env to close.
LIVE_OPEN=0 — /open lookup only. Set LIVE_OPEN=1 in .env to mint.
watch 2 open · hits 0
```

Kalau posisi sudah kena SL/TP, yang muncul `DRY stop loss PAIR …` — masih belum close.

Kalau log-nya benar, `Ctrl+C`, ganti `LIVE_CLOSE=1`, lalu `npm start` lagi. Tutup terminal atau HP/laptop tidur = **TP/SL mati**. Untuk 24 jam, pakai Railway atau VPS.

### B. Railway (paling gampang untuk 24 jam)

1. Buka [railway.app](https://railway.app), login dengan GitHub.
2. **New project** → **Deploy from GitHub repo** → `0xyanman/metina-tpsl`  
   (fork dulu ke GitHub kamu kalau tidak bisa deploy repo orang lain).
3. Buka service → **Variables**, isi sama seperti `.env`:
   - `METINA_URL` = `https://pro.metina.id`
   - `METINA_EMAIL`
   - `METINA_PASSWORD`
   - `EVM_PRIVATE_KEY`
   - `RPC_BSC` / `RPC_BASE` / `RPC_ROBINHOOD` (wajib — setiap chain yang dipakai)
   - `LIVE_CLOSE` = `0`
   - `LIVE_OPEN` = `0`
4. Start command sudah `npm start` (`node src/index.js`). Tidak perlu build khusus.
5. Buka **Deployments → Logs**. Pastikan ada `logged in` dan `watch N open`.
6. Kalau log DRY sudah benar, ganti `LIVE_CLOSE` jadi `1` lalu redeploy.

Railway menjaga proses tetap hidup. Kalau trial tidur sendiri, upgrade atau pindah ke VPS.

### C. VPS + pm2 (Ubuntu)

```bash
sudo apt update
sudo apt install -y git nodejs npm
git clone https://github.com/0xyanman/metina-tpsl.git
cd metina-tpsl
cp .env.example .env
nano .env          # isi sama, mulai dari LIVE_CLOSE=0
npm install
sudo npm install -g pm2
pm2 start src/index.js --name metina-tpsl
pm2 logs metina-tpsl
pm2 startup
pm2 save
```

Setelah log DRY benar:

```bash
# di .env ganti LIVE_CLOSE=1
pm2 restart metina-tpsl
```

```bash
pm2 status          # harus "online"
pm2 logs metina-tpsl --lines 50
```

### Telegram (opsional)

Kosongkan `TELEGRAM_*` kalau tidak mau notifikasi.

Untuk nyalain: buat bot lewat [@BotFather](https://t.me/BotFather), masukkan ke chat / grup / topik forum, lalu isi di `.env` atau Railway Variables:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...                 # ID chat / grup / channel
TELEGRAM_MESSAGE_THREAD_ID=          # opsional: topik forum
TELEGRAM_ENABLED=1
```

Saat start harus muncul `Telegram notifications enabled` dan `Telegram command listener started`.

Perintah (hanya dari chat itu):

- `/refresh` — kirim ringkasan posisi open terkini
- `/help` — daftar perintah
- `/open <0x token> <amount> [chain]` — buka LP via Metina Pro (lihat di bawah)
- `/close all` — tutup semua posisi open
- `/close profit` — tutup hanya posisi yang sedang profit
- `/close <id>` — tutup satu posisi (`/close 933596`, atau `/close 1` sesuai nomor di kartu ringkasan terakhir)

`/close` diabaikan selama `LIVE_CLOSE=0`. `/close` tanpa target tidak menutup apa pun. Siapa pun di chat itu bisa kirim perintah.

Worker membatasi command Telegram supaya chat tidak membanjiri Metina Pro: **2 detik** antar command, **45 detik** antar `/open`, **10 detik** antar `/close`. `/open` berikutnya saat mint masih jalan di-drop. Pro juga rate-limit per IP worker (`/api/web` 60/menit, write deploy/close 100 per 5 menit).

### Buka LP dari Telegram

Alurnya sama seperti desk Pro: `lookup` lalu `deploy`. Worker tidak mint sendiri.

1. Nyalakan Telegram (bagian di atas).
2. Mulai dengan `LIVE_OPEN=0`. Kirim `/open` — harus dapat `[DRY] Would Open` (pool, amount, range). Belum mint.
3. Set `LIVE_OPEN=1` lalu restart. Command yang sama baru benar-benar buka posisi.

```
/open <0x token> <amount> [chain] [quote] [side] [sl] [tp]
```

```
/open 0xabc… 0.5 robinhood
/open 0xabc… 0.5 robinhood quote=usdg sl=-50 tp=20
/open 0xabc… 0.5 robinhood quote=eth side=single
/open 0xabc… 100 bsc quote=usdt side=double
/open 0xabc… 0.5 base quote=usdc
```

**Amount dalam token quote**, bukan USD. `0.5 robinhood` = 0.5 USDG. `quote=eth` = 0.5 ETH.

| Chain | Quote default | Quote lain |
|---|---|---|
| `robinhood` | `USDG` | `quote=eth` |
| `base` | `USDC` | `quote=eth` |
| `bsc` | `USDT` | `quote=bnb` |

Sama seperti desk Pro. Bisa juga ditulis langsung: `/open 0xabc… 100 bsc usdt`.

`side=single`, `side=double`, dan `side=token` sama seperti pilihan side di Open LP desk Pro. Bisa juga ditulis langsung: `/open 0xabc… 0.5 robinhood double`.

| Side | Artinya | Range default |
|---|---|---|
| `single` (default) | Quote-only di bawah spot (USDG / USDT / ETH, belum pegang meme sampai harga masuk range) | `−80% … −1%` |
| `double` | Two-sided · swap meme seperlunya | `−60% … +150%` |
| `token` | Token-only di atas spot | `+1% … +150%` |

Pilih side = range itu yang dipakai, kecuali di-override `min=` / `max=`.

| Bagian | Default |
|---|---|
| Chain | `auto` (atau `robinhood` / `base` / `bsc`) |
| Quote | sesuai chain di atas (`USDG` / `USDC` / `USDT`) |
| Side | `single` |
| SL / TP | kosong (worker tidak auto-close sampai diisi) |

Opsional: `min=` / `max=`, `pool=0x…`. Token harus alamat EVM `0x`. Solana / DLMM tidak didukung (worker ini tidak punya key Solana).

Kalau `/open` dikasih `sl=` / `tp=`, closer pakai level itu di cycle berikutnya. Kalau tidak, isi SL/TP di kartu Open Pro seperti biasa.

### Yang perlu diingat

- Tutup worker = TP/SL mati (sama seperti tutup tab).
- Kartu posisi tanpa SL/TP = tidak di-close.
- PnL on-chain belum valid = skip (supaya tidak salah tembak).
- Key dikirim ke Metina **hanya saat close dan open (deploy)**, di memori request, tidak disimpan di database.
- RPC Settings ada di browser member, bukan di database Metina. Worker harus kirim dari `.env`.
- Folder ini **project terpisah**. Jangan taruh `.env` member ke server Metina Pro.
