"""
auction
The server-owned auction room: state, rules, and the socket in front of them.

  room.py      the auction itself — phases, bidding, legality, undo, report
  schemas.py   the WebSocket contract, and the only place client input is trusted after
  ws.py        connections, validation, attribution, broadcast

Imported by api.main, which mounts the router and loads the player pool at
startup.
"""
