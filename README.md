# IPL Auction Arena

A local multiplayer IPL auction game for up to 20 teams.

## Run

```powershell
npm start
```

Open `http://localhost:3000`.

## Host Flow

1. Enter the budget per team and bid step, such as `100 cr` and `10 lakh`.
2. Create a host room.
3. Upload an `.xlsx` or `.csv` player list.
4. Share the room link with friends.
5. Start the auction.

The host can join as a bidding team, pause/resume the live auction, and skip the current player. Every player gets a 15 second timer, and every new bid resets it. When the timer reaches zero, the player is sold to the highest bidder or marked unsold if there is no bid. The sold/unsold popup is shown briefly before the next player appears.

## Player Sheet Columns

Use these column names:

```csv
name,base price,set,role,points
```

Supported auction sets are run in this order:

```text
marquee
batsmen set-1
wk batsmen set-1
all rounders set-1
bowlers set-1
batsmen set-2
wk batsmen set-2
all rounders set-2
bowlers set-2
```

`sample-players.csv` is included for testing.
