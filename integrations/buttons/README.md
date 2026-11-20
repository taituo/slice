# Call-me-back buttons

Press a button and the AI phones you. The button can be a physical one on the fridge or by the door,
or a button in the app. Each press goes to `callbackWorkflow` in Temporal, which:

1. collects presses for a few seconds (five presses = one call; a double press upgrades to "my usual"),
2. respects the button's quiet hours (a press at night is scheduled for the morning),
3. prepares context: the open order, an open support case, an upcoming class. For "my usual", nearby
   kitchens bid on your last order before the call, so the agent can offer the best price,
4. calls through ElevenLabs. The voice is our own deep agent, already holding that context,
5. retries if you don't answer, then texts you instead.

| Press | Default action |
| --- | --- |
| single | Call me back |
| double | Call me about my usual order (best competing price, confirm by voice) |
| long | Cancel a pending callback |

## Register a button

```bash
# 1. Sign in (phone code), then create the button with your session token
curl -X POST $API/v1/me/buttons -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"label":"Fridge button","kind":"physical","tenant":"slice","quietFrom":22,"quietTo":8}'
# → { "id": "btn_…", "token": "sk_btn_…", "pressUrl": "https://…/v1/buttons/btn_…/press" }
```

The token is shown once and stored hashed. Revoke a lost button with `DELETE /v1/me/buttons/<id>`.

## Wire up the device

Any device that can make an HTTPS request works. Send the token in the `x-button-token` header, or
as `?token=` on the URL for devices that can only fetch a URL (the press URL accepts GET and POST).

| Device | Setting |
| --- | --- |
| Flic 2 (HTTP request action) | `pressUrl?press=single` (click), `?press=double` (double click), `?press=long` (hold), with the token header or `&token=` |
| Shelly Button1 / i4 | Actions → URL: `pressUrl?token=…&press=single` (short), `…double` (double), `…long` (long) |
| ESP32 / any microcontroller | See `esp32-button.ino` |
| Home Assistant | `rest_command` with the same URL, bound to any button or automation |
| App | `POST /v1/me/callback` with the session token, or "Call me" on the order tracker |

The system can also call by itself: a support case that misses its approval SLA starts a callback
(`source = system:…`).
