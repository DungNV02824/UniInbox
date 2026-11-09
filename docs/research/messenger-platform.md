# Messenger Platform (Facebook Page inbox): verified facts for the connector

Researched: 2026-11-05. Sources are official Meta for Developers pages only. Quotes are copied from the live pages on that date.

Meta has moved the Messenger docs from `developers.facebook.com/docs/messenger-platform/...` to `developers.facebook.com/documentation/business-messaging/messenger-platform/...`. The old URLs redirect. Most new pages also have a raw Markdown version: add `.md` to the URL. Those `.md` files are the most reliable copy to read.

Labels used below:

- **[DOC]**: stated by the official doc.
- **[INFERENCE]**: our reading or recommendation. The doc does not say it outright.
- **[AMBIGUOUS]**: the docs disagree with each other, or are unclear.

---

## 1. Graph API version

**[DOC]** The newest released version is **v26.0**. It was released on July 29, 2026, and its expiration date is "TBD".

| Version   | Release date      | Available until                      |
| --------- | ----------------- | ------------------------------------ |
| **v26.0** | July 29, 2026     | TBD                                  |
| v25.0     | February 18, 2026 | July 29, 2028                        |
| v24.0     | October 8, 2025   | February 18, 2028                    |
| v23.0     | May 29, 2025      | October 8, 2027                      |
| v22.0     | January 21, 2025  | May 20, 2027                         |
| v21.0     | October 2, 2024   | January 21, 2027                     |
| v20.0     | May 21, 2024      | September 24, 2026 (already removed) |
| v19.0     | January 23, 2024  | May 21, 2026 (already removed)       |

- The v26.0 changelog lists these out-of-cycle removals: "Graph API v20.0 is removed on September 24, 2026, and v21.0 on January 21, 2027."
- The v26.0 changelog has **no changes** for Messenger Platform, webhooks, message tags or user profile.
- **[AMBIGUOUS]** Several current Messenger pages already use **`v27.0`** in their curl samples: Send API reference, Send a message, Saving assets, Attachment Upload API. However:
  - the versions table does not list v27.0;
  - `/docs/graph-api/changelog/version27.0` returns **404**.

  v27.0 is probably about to ship, but it is not released as of today.

- **Recommendation [INFERENCE]:** pin **v26.0** and keep the version in config (for example `META_GRAPH_VERSION=v26.0`). Expect to move to v27.0 soon.

Sources:

- https://developers.facebook.com/docs/graph-api/changelog/versions
- https://developers.facebook.com/docs/graph-api/changelog/version26.0

---

## 2. Webhook verification, signature, retries

### 2a. Verification request (GET)

**[DOC]** Sample request:

```
GET https://www.your-clever-domain-name.com/webhooks?
  hub.mode=subscribe&
  hub.verify_token=mytoken&
  hub.challenge=1158201444
```

Your endpoint must:

> "Verify that the `hub.verify_token` value matches the string you set in the **Verify Token** field … Respond with the `hub.challenge` value."

Parameters:

- `hub.mode`: "This value will always be set to `subscribe`."
- `hub.challenge`: "An `int` you must pass back to us."

The official sample code returns `res.status(200).send(challenge)` when the token matches. Otherwise it returns `res.sendStatus(403)`.

**Implementation:** if `hub.mode === "subscribe"` and the token matches (use a constant-time compare), reply **HTTP 200** with the raw `hub.challenge` string as a `text/plain` body. Otherwise reply **403**.

### 2b. Signature (POST)

**[DOC]**

> "We sign all Event Notification payloads with a **SHA256** signature and include the signature in the request's 'X-Hub-Signature-256' header, preceded with 'sha256='."
>
> "Generate a **SHA256** signature using the payload and your app's **App Secret**. Compare your signature to the signature in the `X-Hub-Signature-256` header (everything after `sha256=`)."
>
> "**Note:** Please note that we generate the signature using an _escaped unicode_ version of the payload, with lowercase hex digits. If you just calculate against the decoded bytes, you will end up with a different signature. For example, the string `äöå` should be escaped to `äöå`."

The official sample computes `crypto.createHmac("sha256", config.appSecret).update(buf).digest("hex")`. Here `buf` is the raw request body that body-parser's `verify` hook passes in.

So the format is `X-Hub-Signature-256: sha256=<lowercase hex HMAC-SHA256(appSecret, rawBody)>`.

**[INFERENCE]** Meta sends the body with non-ASCII characters already escaped as `\uXXXX`. Hashing the **raw received bytes** therefore matches. The doc's warning is against hashing a re-serialized or decoded form, such as `JSON.stringify(JSON.parse(body))`, which would turn `ä` back into `ä`.

In our Fastify/Express handler:

- capture the raw `Buffer` before JSON parsing;
- HMAC that buffer;
- compare with `crypto.timingSafeEqual`, checking lengths first;
- reject a missing or invalid signature with 401 or 403.

### 2c. Response requirements, retries, disabling

**[DOC]** Messenger webhooks page:

> "Your endpoint should respond to all notifications: with a `200 OK HTTPS` response; within 5 or less seconds"
>
> "If a notification sent to your server fails, we will immediately try a few more times. Your server should handle deduplication in these cases. If, after 15 minutes, we are still unable to deliver notifications, an alert is sent to your developer account."
>
> "If delivery of a notification continues to fail for 1 hour, you will receive a **Webhooks Disabled** alert, and your app will be unsubscribed from the webhooks for the Page or Instagram Professional account. Once you have fixed the issues you will need to subscribe to the Webhooks again."
>
> "If multiple messages are sent by the user when the application fails, they may not be delivered in the order they were sent. To ensure chronological order of message delivery, applications should always use the webhook **timestamp** field."

Also: "Self-signed certificates are not supported."

**[AMBIGUOUS]** The generic Graph API webhooks page describes a different retry policy:

> "we will retry immediately, then try a few more times with decreasing frequency over the next 36 hours"

The same generic page says batches can hold "a maximum of 1000 updates", but "batching cannot be guaranteed".

For Page messaging, the Messenger-specific rule applies: **after 1 hour of failures the Page subscription is removed**. This is the more dangerous of the two rules.

**Implementation [INFERENCE]:**

- Verify the signature, persist or enqueue the raw event, and reply 200 at once (well under 5 seconds).
- Process asynchronously (BullMQ).
- Make processing idempotent on `mid`, or on (`sender`, `watermark`) for receipts.
- Alert if the webhook error rate rises.
- Run a periodic health check: `GET /{page-id}/subscribed_apps`. If our app is missing, re-subscribe automatically.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks (Markdown: same URL + `.md`)
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started

---

## 3. Page webhook payload shapes

### Envelope

**[DOC]**

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1458692752478,
      "messaging": [
        {
          "sender": { "id": "<PSID>" },
          "recipient": { "id": "<PAGE_ID>" },
          "timestamp": 1458692752478,
          "...": "..."
        }
      ]
    }
  ]
}
```

- "The `entry` array contains one or more event objects, each with a `messaging` array of individual events."
- "Every event in the `messaging` array includes `sender`, `recipient`, and `timestamp` fields."
- The event type is decided by which key is present: `message` (and `message.is_echo`), `delivery`, `read`, `postback`, `referral`, `reaction`, and so on.
- Iterate over **all** entries and **all** events. One POST can contain several pages and several events.

### 3a. `messages` (field `messages`)

**Text** (with optional quick reply and reply-to):

```json
{
  "sender": { "id": "<PSID>" },
  "recipient": { "id": "<PAGE_ID>" },
  "timestamp": 1458692752478,
  "message": {
    "mid": "mid.1457764197618:41d102a3e1ae206a38",
    "text": "hello, world!",
    "quick_reply": { "payload": "<DEVELOPER_DEFINED_PAYLOAD>" },
    "reply_to": { "mid": "m_1fTq8oLumEyIp3Q2MR-aY7IfLZDamVrALniheU", "is_self_reply": false }
  }
}
```

**Attachments.** The `message.attachments[].type` values are: "`audio`, `file`, `image` (including gif), `sticker`, `video`, `fallback`, `reel`, `ig_reel`, `post`, `ig_post` or `appointment_booking`".

```json
"message": {
  "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
  "attachments": [
    { "type": "<image|video|audio|file|sticker|reel|ig_reel>", "payload": { "url": "<ATTACHMENT_URL>" } }
  ]
}
```

**Sticker:**

```json
"attachments": [ { "type": "sticker", "payload": { "url": "<STICKER_URL>", "sticker_id": 369239263222822 } } ]
```

- **[DOC]** `sticker_id` (Number) is the "Persistent id of this sticker, for example `369239263222822` references the Like sticker".
- **[DOC]** Transition notice:

  > "Sticker messages in webhooks now include a new `sticker` attachment type with `sticker_id` metadata. During the 90-day transition period, both the `sticker` and `image` attachment types are present in the payload. After August 30, 2026, only the `sticker` attachment type will be sent. … The same change applies to message echoes."

- Today is past August 30, 2026, so we should receive only `type: "sticker"`.
- **[INFERENCE]** Still treat an `image` attachment that has `payload.sticker_id` as a sticker. Do not create a duplicate media message when both a `sticker` and an `image` item appear in one message.

**Fallback** (link shares; v6.0+). Text can be present together with the attachment.

```json
"message": {
  "mid": "m_toDnmD...",
  "text": "This is where I want to go: https:\/\/youtu.be\/bbo_fZAjIhg",
  "attachments": [ { "type": "fallback", "payload": { "url": "<ATTACHMENT_URL >", "title": "TAHITI - Heaven on Earth" } } ]
}
```

**[DOC]** "For unsupported shares made by users to your Page a `fallback` with no payload might be sent." Handle a missing `payload`.

**Other attachment types:**

- **Post share**: `type: "post" | "ig_post"`, payload `{url, title, id}`.
- **Product template**: `type: "template"`, payload `{product: {elements: [{id, retailer_id, image_url, title, subtitle}]}}`. This needs the `catalog_management` permission.
- **Appointment booking**: payload `{booking_id, status, start_time, end_time, timezone}`.
- `reel` / `ig_reel`: payload `{url, title, reel_video_id}`.

**Other `message` properties:**

- `commands: [{name}]`.
- `admin_text` and `handoff_reason`. These come from Meta first-party handoff (Business AI). Such a message "can be sent without an underlying message. In this case, `mid` and `text` are not included." **Do not treat these as customer messages.**

**Referral inside a message** (Click-to-Messenger ad, first message):

> "Message with Ads Referral Information requires the application to have page subscriptions to both the `messages` and the `messaging_referrals` fields."

```json
"message": {
  "mid": "mid.1457764197618:41d102a3e1ae206a38",
  "text": "hello, world!",
  "referral": {
    "ref": "<REF_DATA_IF_SPECIFIED_IN_THE_AD>",
    "ad_id": "<ID_OF_THE_AD>",
    "source": "ADS",
    "type": "OPEN_THREAD",
    "ads_context_data": {
      "ad_title": "<TITLE_OF_THE_AD>",
      "photo_url": "<URL_OF_THE_IMAGE_FROM_AD_THE_USER_IS_INTERESTED_IN>",
      "video_url": "<THUMBNAIL_URL_OF_THE_VIDEO_FROM_THE_AD>",
      "post_id": "<ID_OF_THE_POST>",
      "product_id": "<PRODUCT_ID>",
      "flow_id": "<ID_OF_THE_PARTNER_APP_WELCOME_MESSAGE_FLOW>"
    }
  }
}
```

A Shops product-detail-page referral looks like `"referral": {"product": {"id": "<PRODUCT_ID>"}}`.

**[DOC]** "Messages are always sent in order." The webhooks page adds that after delivery failures the order is not guaranteed, so **sort by `timestamp`**.

### 3b. `message_echoes` (field `message_echoes`)

**[DOC]** "This callback occurs when your page sends a message."

```json
{
  "sender": { "id": "<PAGE_ID>" },
  "recipient": { "id": "<PSID>" },
  "timestamp": 1457764197627,
  "message": {
    "is_echo": true,
    "app_id": 1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid": "mid.1457764197618:41d102a3e1ae206a38",
    "text": "hello, world!"
  }
}
```

- `sender` = "The ID for your Facebook Page".
- `recipient` = "The Page-scoped ID for the person who received a message from your business". **The customer's PSID is in `recipient.id`.**
- `metadata`: "Custom string passed to the Send API as the `metadata` field. Only present if the `metadata` property was set in the original message."
- `app_id`: listed as type "String" in the table, but the examples show a JSON number. **Normalize with `String(x)`.**
- Attachments use the same shapes as in 3a: `image`, `audio`, `video`, `file`, `sticker`, `template`, `fallback`, `appointment_booking`, products.
- In echoed templates, "the attachment id sent is a number not a string".
- Echoes can also arrive under `entry[].standby[]`. Example 2 on the echo page shows an echo inside `standby`.

### 3c. `message_deliveries`

```json
{
  "sender": { "id": "<PSID>" },
  "recipient": { "id": "<PAGE_ID>" },
  "delivery": { "mids": ["<MESSAGE_ID>"], "watermark": 1458668856253 }
}
```

**[DOC]** "watermark is always present and is a timestamp indicating that all messages with a timestamp before watermark were delivered". `mids` "may not be present".

**Implementation:** mark all outbound messages in that conversation with `sent_at <= watermark` as delivered. Use `mids` only when it is present.

### 3d. `message_reads`

```json
{
  "sender": { "id": "<PSID>" },
  "recipient": { "id": "<PAGE_ID>" },
  "timestamp": 1458668856463,
  "read": { "watermark": 1458668856253 }
}
```

**[DOC]** "all messages that were sent before or at this timestamp were read".

### 3e. `messaging_referrals`

**[DOC]** This event fires only "when the user already has a thread with the bot" and comes back through an m.me link with a `ref` parameter, or through a Conversation Ad. "For tracking referrals in new threads, refer to Postback Event."

```json
{
  "sender": { "id": "<PSID>" },
  "recipient": { "id": "<PAGE_ID>" },
  "timestamp": 1458692752478,
  "referral": {
    "ref": "<REF>",
    "ad_id": "<ID_OF_THE_AD>",
    "source": "ADS",
    "type": "OPEN_THREAD",
    "ads_context_data": {
      "ad_title": "...",
      "photo_url": "...",
      "video_url": "...",
      "post_id": "...",
      "product_id": "...",
      "flow_id": "..."
    }
  }
}
```

- `source` values on this page: `ADS`, `SHORTLINK`.
- `type`: "Currently only `OPEN_THREAD`".
- There is also an optional `referer_uri`.

**[INFERENCE]** Where the ad attribution shows up:

- **New thread from a CTM ad:** `message.referral` (on the first message), or `postback.referral` (if the user tapped a Get Started or ice-breaker CTA).
- **Existing thread:** a standalone `referral` event (`messaging_referrals`), then the user's message.

Store ad attribution from all three paths.

### 3f. `messaging_postbacks`

**[DOC]** This fires when "a customer clicks a postback button, Get Started button, or persistent menu item".

```json
{
  "sender": { "id": "<PSID>" },
  "recipient": { "id": "<PAGE_ID>" },
  "timestamp": 1458692752478,
  "postback": {
    "mid": "m_MESSAGE-ID",
    "title": "<BUTTON_TITLE>",
    "payload": "<DEVELOPER_DEFINED_PAYLOAD>",
    "referral": { "ref": "...", "source": "ADS|SHORTLINK", "type": "OPEN_THREAD" }
  }
}
```

- `postback.referral` is present only when the person started the conversation through an m.me link, Click-to-Messenger ad, QR code or Welcome Screen, then tapped a CTA.
- "This is only included in the webhook notification sent to the app that sent the message to the person." This refers to `payload`.

**[INFERENCE]** For an inbox, show postbacks as a customer action with the button title as text, for example "Get Started".

### 3g. `standby` (`entry[].standby[]`): should we handle it?

**[DOC]**

> "this callback will occur when a message has been sent to your page, but your application is not the current thread owner. Instead of delivering the callback through the normal `messaging` channel, the events will be delivered to `standby` channel."

- Events delivered on standby: `message_reads`, `message_deliveries`, `messages`, `messaging_postbacks`. Postbacks on standby have no `payload`.
- "When Meta Business AI owns the conversation, a `standby` event does not transfer ownership to your app. Wait for a `messaging_handovers` webhook event containing `pass_thread_control` before responding as the thread owner."
- Conversation Routing, default behavior (no default app set): "All connected applications receive messaging webhooks. All applications can respond to the same user message without restrictions."
- With Conversation Routing enabled: "Conversation routing allows your business to use Meta Business Suite Inbox as another application connected to your page … if you move a message to the Main folder or respond to a message in a conversation not controlled by the inbox, the inbox takes control of the conversation."
- If another app controls the thread, sending fails with `10 / 2018300`.

**Recommendation [INFERENCE]: YES, subscribe to `standby` and also `messaging_handovers`.**

- Parse `entry[].standby[]` with the same parser as `messaging[]`.
- Ingest those events so the omni-inbox shows the full conversation.
- Mark the conversation "controlled by another app".
- Do not auto-reply from standby.

Without this, any Page that uses Business Suite inbox routing or Meta Business AI will silently drop customer messages from our inbox.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes
- https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-deliveries
- https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-reads
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_referrals
- https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_postbacks
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/standby
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing

---

## 4. Are webhook attachment URLs temporary?

**[AMBIGUOUS / not documented]** The `messages` and `message_echoes` reference pages describe `payload.url` only as "URL of the attachment type". They do **not** say whether it expires.

Related facts that are documented:

- **[DOC]** User Profile API: `profile_pic` is a "URL to the Profile picture. **The URL will expire.**"
- **[DOC]** Saving assets / Attachment Upload API: "**Attachment IDs expire after 90 days.** … Attachments in message threads never expire and are visible until a user deletes the message from the thread." This is about reusable _upload_ IDs that we send, not inbound URLs.
- **[DOC]** The Graph `/{message-id}/attachments` edge returns `id`, `mime_type`, `name`, `size` and `file_url`. It "requires a Page access token with … `pages_messaging`". It gives no expiry statement.

**[INFERENCE]** Inbound URLs are signed Meta CDN URLs, the same kind of URL as `profile_pic`, which is documented to expire. Treat them as **short-lived**.

- Download to S3 immediately in the webhook worker (with retries).
- Store the S3 key, `mid`, attachment `type` and `sticker_id`.
- Never store the CDN URL as the canonical reference.
- If a download fails after the URL has expired, try re-fetching through the Conversations API (`GET /{mid}?fields=attachments` with the Page token). This fallback has not been verified.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/saving-assets
- https://developers.facebook.com/docs/graph-api/reference/message/attachments/

---

## 5. Send API

### Endpoint and requirements

**[DOC]** Send API reference, "Before You Start":

> "A Page access token requested by a person who can perform the `MESSAGE` task on the Page; The `pages_messaging` permission; The message recipient must have sent your Page a message within the last 24 hours or agreed to receive messages from your Page outside of the standard 24 hour messaging window"

- Endpoint: `POST https://graph.facebook.com/{version}/{PAGE_ID}/messages`.
- The samples also use `/me/messages` with the Page token, because `/me` resolves to the Page. The Graph overview says `/me` "translates to the object ID of the person or Page whose access token is currently being used".
- The access token can go in the query string (`?access_token=`) or in the body.

```bash
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{"id":"<PSID>"},
  "messaging_type": "RESPONSE",
  "message":{"text":"Hello, world!"}
}' "https://graph.facebook.com/v26.0/{PAGE-ID}/messages?access_token={PAGE-ACCESS-TOKEN}"
```

Response: `{"recipient_id": "PAGE-SCOPED-ID", "message_id": "AG5Hz2U..."}`.

- When you upload and save in the same call, the response also has `attachment_id`.
- **[DOC]** "the Send API does not include `recipient_id` in the response for messages sent using `recipient.user_ref` or `recipient.phone_number`".

### Parameters (Send API reference) [DOC]

- **`messaging_type`** (required):
  - `RESPONSE`: "in response to a received message … inside the 24-hour standard messaging window".
  - `UPDATE`: sent proactively, inside the window.
  - `MESSAGE_TAG`: "non-promotional and is being sent outside the 24-hour standard messaging window with a message tag".
  - The Graph `page/messages` reference also lists `UTILITY` (for utility templates).
- **`tag`**: `HUMAN_AGENT`, `CUSTOMER_FEEDBACK`. `ACCOUNT_UPDATE`, `CONFIRMED_EVENT_UPDATE` and `POST_PURCHASE_UPDATE` are being removed; see section 6.
- **`message.text`**: "A message containing text only. **Must be UTF-8 and less than 2000 characters.**"
- **`message.metadata`**: "A string of additional data you want to pass in the `message_echo` webhook. **Must be less than 1000 characters**".
- **`message.attachment.type`**: "Can be `audio`, `file`, `image`, `template`, or `video`. Maximum file size is 25MB".
- **`message.attachments`** (array): "The only media type allowed is an image, and it is limited to 30 images at once."
- **`reply_to.mid`**: quote a specific message. "The page should have received a message from the user within the last 24 hours."
- **`notification_type`**: `REGULAR` (default), `SILENT_PUSH`, `NO_PUSH`.
- **`sender_action`**: `typing_on`, `typing_off`, `mark_seen`. It "Cannot be sent with the `message` parameter but must be sent as a separate request."

**[AMBIGUOUS]** "less than 2000 characters" literally means at most 1999. The doc does not say whether it counts UTF-16 code units or code points. **[INFERENCE]** Split outbound text into chunks of at most 1999 UTF-16 code units, preferring whitespace or newline boundaries, and do not split a surrogate pair.

### Sending images and files

**(a) By URL (JSON)** [DOC]:

```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "RESPONSE",
  "message": {
    "attachment": { "type": "image", "payload": { "url": "https://.../image.jpg", "is_reusable": false } }
  }
}
```

- URL limits: "Max file size is 8 MB for images and 25 MB for all other file types (after encoding). Timeout is 75 seconds for videos and 10 seconds for all other file types."
- Meta must be able to fetch the URL: a public HTTPS URL with a valid certificate, for example an S3 presigned URL.
- Error `100/2018008` means "Failed to fetch the file from the url".

**(b) Multipart upload in the same Send request (`filedata`)** [DOC] (Saving assets):

> "Submit your message request as form data, and specify the file location in the `filedata` field"

```bash
curl \
  -F 'recipient={"id":"<PSID>"}' \
  -F 'message={"attachment":{"type":"<ASSET_TYPE>", "payload":{"is_reusable":true}}}' \
  -F 'filedata=@/tmp/shirt.png;type=image/png' \
  "https://graph.facebook.com/v27.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

Multipart field names:

- `recipient`: JSON string.
- `message`: JSON string, `attachment.type` plus `payload`.
- `filedata`: the file part, with its correct `Content-Type`.
- Add `messaging_type` (and `tag` if needed) as further form fields, following the Send API rule that `messaging_type` is required.
- `access_token` goes in the query string.

For one-step sends, the doc says "Do **not** set `is_reusable` to `true` when uploading and sending in one step." Leave it out or set it to `false`. Audio: "`Content-Type` header must use type `audio` (for example, `audio/mp3`)".

**(c) Attachment Upload API** (upload first, send later) [DOC]: `POST /{PAGE_ID}/message_attachments`. The response is `{"attachment_id":"1857777774821032"}`.

From a URL:

```bash
curl -X POST "https://graph.facebook.com/v26.0/{PAGE_ID}/message_attachments" -H "Content-Type: application/json" \
  -d '{"access_token":"<PAGE_TOKEN>","message":{"attachment":{"type":"image","payload":{"url":"https://.../image.jpg","is_reusable":true}}}}'
```

Then send with `"payload": {"attachment_id": "<ID>"}`.

- "This ID is private and only the Page that originally sent the attachment can reuse it."
- "**Attachment IDs expire after 90 days.**"

**[AMBIGUOUS]** The docs' "upload from file" examples for `/message_attachments` are broken:

- The Attachment Upload API reference puts `"filedata": "@/path..."` inside a JSON body. That cannot upload a file.
- The Saving-assets page's "Save from file" sample for this API actually posts to `/me/messages`.

**[INFERENCE]** The working form is multipart to `/{PAGE_ID}/message_attachments` with:

- `message={"attachment":{"type":"image","payload":{"is_reusable":true}}}`
- `filedata=@file;type=image/png`

That is the same field names as (b), without `recipient`. Verify in a sandbox before relying on it.

**[AMBIGUOUS]** The Attachment Upload API reference says that sending with an `attachment_id` returns `{"success": "true"}`. The Send API reference says sends return `{recipient_id, message_id}`. Code defensively: accept both shapes. If `message_id` is missing, match the later echo by `metadata` instead.

**Recommendation [INFERENCE]:** for agent replies with images, use **(b) multipart `filedata`** from the bytes we already hold in S3. It needs no public URL and does not create reusable IDs that expire after 90 days. Option (a) with a short-lived presigned S3 URL is also fine for images up to 8 MB.

Sources:

- https://developers.facebook.com/docs/messenger-platform/reference/send-api (redirects to `/documentation/business-messaging/messenger-platform/reference/send-api`)
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/saving-assets
- https://developers.facebook.com/docs/messenger-platform/reference/attachment-upload-api
- https://developers.facebook.com/docs/graph-api/reference/page/messages/
- https://developers.facebook.com/docs/graph-api/overview

---

## 6. Messaging windows and message tags

### Standard window [DOC]

> "The duration of the standard messaging window depends on the user action that opens it. For most user actions, it lasts 24 hours. When the user action is a person sending their first message after clicking a Click-to-Messenger or Click-to-Direct ad, the window may last up to 7 days from that message. Messages sent within the standard messaging window may contain promotional content."

User actions that open or reopen the window:

- the user messages the Page;
- the user taps a CTA such as Get Started;
- the user's first message after a CTM ad (up to 7 days);
- a plugin message;
- an m.me or ig.me link into an existing thread;
- a **reaction to a message**;
- a comment on a Page post;
- a visitor post.

**Click-to-Messenger ads [DOC]:**

- The window "may last up to 7 days" from the user's first message after clicking the ad. Note the wording "may".
- Conversation Routing adds: "For conversations that start from a Click-to-Messenger ad, the designated app's default thread-control duration automatically matches the standard messaging window for that conversation - up to 7 days from the person's first message after clicking the ad."

**[INFERENCE]** We cannot know for sure from the webhook whether a given thread got the full 7 days. Store `window_opened_at`, plus `ctm_referral = true` when `referral.source === "ADS"` arrived with the first message.

- Allow `RESPONSE` sends for up to 7 days on those threads, and 24 hours otherwise.
- If the API returns an outside-window error (section 7), fall back to `HUMAN_AGENT` when that tag is approved and we are within 7 days.

### Message tags [DOC]

> "**Effective April 27th, 2026, all API requests containing the Message Tags CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, and POST_PURCHASE_UPDATE will receive error code 100.**"

This date has passed. The only general-purpose tags left are:

- **`HUMAN_AGENT`**:

  > "When this tag is added to a message being sent to a person, it allows a human agent to respond to the person's message. Messages can be sent within 7 days of the person's message. Human agent support is for issues that cannot be resolved within the standard messaging window."
  - "Apps will need to apply for the Human Agent permission via the Developer App dashboard. Navigate to App dashboard -> App review -> Permissions & Features -> Human Agent."
  - "Your app must be approved before you can use the human agent tag."
  - Allowed: "issues that cannot be resolved within the 24 hour standard messaging window, such as resolving issues outside normal business hours". Disallowed: "Automated messages; Content unrelated to user inquiry".
  - The Human Agent feature reference says it "requires successful completion of the App Review process" and "is only available with business verification".

- **`CUSTOMER_FEEDBACK`**: only with the Customer Feedback Template, within 7 days.
- `NON_PROMOTIONAL_SUBSCRIPTION`: only for News Page Index publishers. Not relevant to us.

Other rules:

- Tags "may not be used to send promotional content, including but not limited to: deals, offers, coupons, and discounts."
- For promotional messages outside the window, Meta points to Marketing Messages, Sponsored Messages, One-Time Notifications and Utility Messages.

**Usage:** `messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT"`. The 7 days are counted from the **person's last message**. Use it only for messages typed by a human agent; never for AI or automated sends.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy
- https://developers.facebook.com/docs/messenger-platform/reference/send-api
- https://developers.facebook.com/docs/features-reference/human-agent
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing

---

## 7. Error codes

Error shape [DOC]:

```json
{
  "error": {
    "message": "…",
    "type": "OAuthException",
    "code": 190,
    "error_subcode": 1234567,
    "fbtrace_id": "…"
  }
}
```

Graph errors can also carry `error_user_title` and `error_user_msg`.

| Code / subcode                                     | Meaning (doc text)                                                                                                                                                                          | Class [INFERENCE]                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `10` / `2018278`                                   | "This message is sent outside of allowed window."                                                                                                                                           | Permanent for this send. Mark the conversation window as closed. Retry only with `HUMAN_AGENT` if eligible. |
| `10` / `2534022`                                   | "This message is sent outside of allowed window."                                                                                                                                           | Same as above. The table lists this subcode next to the IG errors, but its wording is generic.              |
| `10` / `2018065`                                   | "Outside of allowed window. You need News Messaging permission"                                                                                                                             | Permanent                                                                                                   |
| `10` / `2018108`                                   | "They can't receive your messages right now." (This is **not** the window error.)                                                                                                           | Permanent (recipient unavailable)                                                                           |
| `10` / `2018300`                                   | "The message failed to send because another app controls the conversation."                                                                                                                 | Permanent until a handover. Show "controlled by another app".                                               |
| `10` / `1893063`                                   | "You are temporarily restricted from sending messages." (policy)                                                                                                                            | Non-retryable for now. Alert the Page admin.                                                                |
| `10` (no subcode)                                  | Permission error                                                                                                                                                                            | Permanent (configuration)                                                                                   |
| `100` (various)                                    | Invalid parameter. Also covers the removed tags since April 27, 2026.                                                                                                                       | Permanent                                                                                                   |
| `100` / `2018001`                                  | "No matching user found"                                                                                                                                                                    | Permanent                                                                                                   |
| `100` / `2018008`, `2018047`, `2018109`, `2018294` | Attachment fetch, type, size or timeout failures                                                                                                                                            | Mostly permanent. `2018008` and `2018294` may be worth one retry.                                           |
| `190`                                              | "Invalid OAuth access token." Subcodes `458`, `459`, `460`, `463`, `464`, `467`, `492`. `492` = "User associated with the Page access token does not have an appropriate role on the Page." | Permanent. Mark the channel "needs reconnect" and stop sending.                                             |
| `200`, `200` / `2018028`                           | Permission error / pages_messaging not approved                                                                                                                                             | Permanent (configuration)                                                                                   |
| `200` / `1545041`, `551` / `1545041`               | "This person isn't available right now."                                                                                                                                                    | Permanent for this recipient                                                                                |
| `551`                                              | "User Block Error: This person isn't receiving messages from you right now."                                                                                                                | Permanent for this recipient                                                                                |
| `2018218`                                          | "No profile available for this user." (profile API, phone-number accounts)                                                                                                                  | Permanent. Fall back to "Facebook user".                                                                    |
| `2018247`                                          | Insufficient permission to access user profile                                                                                                                                              | Permanent (configuration)                                                                                   |
| `1`, `2`                                           | Unknown / "unexpected error … retry your request later"                                                                                                                                     | **Transient**: retry with backoff. Note that `2` can also mean the user blocked the Page.                   |
| `4`                                                | "Application request limit reached"                                                                                                                                                         | **Transient**: back off                                                                                     |
| `17`                                               | User request limit reached                                                                                                                                                                  | **Transient**                                                                                               |
| `32`                                               | Pages API rate limit (user token)                                                                                                                                                           | **Transient**                                                                                               |
| `613`, `613` / `2534040`                           | "Calls to this api have exceeded the rate limit."                                                                                                                                           | **Transient**                                                                                               |
| `613` / `2018338`                                  | Abusive message-tag rate warning                                                                                                                                                            | Stop tag sends to this user. Do not auto-retry.                                                             |
| `80006`                                            | Messenger Business Use Case rate limit                                                                                                                                                      | **Transient**. Wait `estimated_time_to_regain_access`.                                                      |
| `368`                                              | "Temporarily blocked for policy violations"                                                                                                                                                 | Do not auto-retry quickly                                                                                   |

**[DOC]** Graph error-handling guide:

- codes 1 and 2: "Wait and retry the operation";
- codes 4 and 17: "Temporary issue due to throttling. Wait and retry the operation, or examine your API request volume";
- code 190: "Get a new access token".

**[AMBIGUOUS]** The window error has two documented subcodes, `2018278` (the classic one) and `2534022`.

- Treat any code-10 error whose message contains "outside of allowed window" as a window error.
- Do **not** map `2018108` to the window error.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes (Markdown: same URL + `.md`)
- https://developers.facebook.com/docs/graph-api/guides/error-handling
- https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- https://developers.facebook.com/docs/graph-api/reference/page/messages/
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing

---

## 8. User profile

**[DOC]** Request:

```
curl -X GET "https://graph.facebook.com/<PSID>?fields=first_name,last_name,profile_pic&access_token=<PAGE_ACCESS_TOKEN>"
```

Requirement:

> "To retrieve a user's profile information, you need to have Advanced Access for the Business Asset User Profile Access feature."

| Field                                   | Requirement                                                          |
| --------------------------------------- | -------------------------------------------------------------------- |
| `id`, `name`, `first_name`, `last_name` | Business Asset User Profile Access feature                           |
| `profile_pic`                           | Same feature. "URL to the Profile picture. **The URL will expire.**" |
| `locale`                                | `pages_user_locale` permission                                       |
| `timezone`                              | `pages_user_timezone` permission                                     |
| `gender`                                | `pages_user_gender` permission                                       |

- The calls use a Page access token, and the app needs `pages_messaging` (Send/Conversations).
- "If the app is unable to access the person's profile, an empty object is returned."
- Phone-number-created accounts return error `2018218`.
- Missing permission returns `2018247`.
- Users arriving from a **Click-to-Messenger ad**: profile access is granted only "after the person replied". Interactions with CTM ads "before the person has replied on Messenger" do not authorize it.

**[INFERENCE]**

- Request `fields=name,first_name,last_name,profile_pic`.
- Copy `profile_pic` to S3 right away. Store the S3 key, not the URL.
- Refresh the profile at most about once a day per contact.
- On an empty object or `2018218`, use the placeholder "Facebook user" and retry later.

Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile

---

## 9. Subscribing a Page, permissions, tokens

### Two subscriptions are needed [DOC]

1. **App-level webhook:** set the callback URL, the verify token and the `page` object fields in App Dashboard > Messenger > Settings, or with `/{app-id}/subscriptions` and an app token.
2. **Per-Page install:**

   ```
   curl -i -X POST "https://graph.facebook.com/<PAGE_ID>/subscribed_apps?subscribed_fields=messages&access_token=<PAGE_ACCESS_TOKEN>"
   ```

   Response: `{"success": "true"}`. Check the install with `GET /<PAGE_ID>/subscribed_apps`, which returns `data[].subscribed_fields`. Remove it with `DELETE` and an App Access Token: "An app can remove its own webhook subscription from a Page with an App Access Token."

**[INFERENCE]** Recommended `subscribed_fields`:

`messages,message_echoes,message_deliveries,message_reads,messaging_postbacks,messaging_referrals,messaging_handovers,standby,message_reactions,message_edits`

All of these are valid values in the subscribed_apps reference.

### Permissions [DOC]

- **Messenger webhooks page**, to subscribe a Page: "A Page access token requested from a person who can perform the `MODERATE` task on the Page" and "The `pages_messaging` and `pages_manage_metadata` permissions".
- **Graph `page/subscribed_apps` reference**, for GET and POST: a Page token from someone who can do "CREATE_CONTENT, MANAGE, or MODERATE", plus `pages_manage_metadata` and `pages_show_list`.
- **`pages_messaging`** "allows your app to manage and access Page conversations and calling in Messenger". It depends on `pages_manage_metadata` and `pages_show_list`.
- Send API: Page token from a person with the `MESSAGE` task, plus `pages_messaging`.
- Advanced Access (App Review) is needed to receive webhooks from and message people who have no role on the app.

> "Advanced Access to receive notifications from your customers, people who do not have a role on your app. Requires App Review."

- Error `200/2018028` occurs until pages_messaging "is reviewed and the app is live".

**Minimum scopes for Facebook Login [INFERENCE]:**

- `pages_show_list`
- `pages_manage_metadata`
- `pages_messaging`
- `pages_read_engagement` (commonly needed for reading Page data; not verified for this flow)
- Feature: **Business Asset User Profile Access**
- Feature: **Human Agent** (optional)

### Identify the Page

`GET /me?fields=id,name` with a Page token returns the Page. Per the Graph overview, `/me` "translates to the object ID of the person or Page whose access token is currently being used". The Messenger webhooks guide uses the same `me?fields=id,name` query in Graph Explorer.

### Long-lived Page token [DOC]

1. Exchange the short-lived user token for a long-lived one:

   ```
   GET https://graph.facebook.com/{version}/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-user-token}
   ```

   "A long-lived token generally lasts about 60 days."

2. Call `GET /{app-scoped-user-id}/accounts?access_token={long-lived-user-token}`. The response's `data[].access_token` holds the Page tokens.
3. "Long-lived Page access token do not have an expiration date."

These tokens can still be invalidated, for example by a password change, the user losing their role on the Page (`190/492`), or the app being removed. Handle `190` by flagging the channel for reconnect.

- "Page access tokens are unique to each Page, admin, and app combination."
- Never ship the app secret to the client.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks
- https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/
- https://developers.facebook.com/docs/permissions/reference/pages_messaging
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens
- https://developers.facebook.com/docs/graph-api/overview

---

## 10. Echo `app_id`: Page inbox, Business Suite, our app

**[DOC]** `app_id` is the "ID of the app from which the message was sent. Starting Graph API `v12.0`+, `app_id` field will return Facebook Page inbox app id (`26390203743090`) whenever the message is sent via Facebook Page inbox." (Source: message_echoes reference.)

**[DOC]** Conversation Routing page: "To pass control to an Inbox, set `target_app_id` to **263902037430900** for the Page Inbox and **1217981644879628** for the Instagram Inbox."

**[AMBIGUOUS]** The echo page prints 14 digits (`26390203743090`). The routing page prints 15 digits (`263902037430900`). The 15-digit value matches the widely used Page Inbox app ID, so the echo page almost certainly dropped the trailing `0`.

**[INFERENCE]** Accept both strings as "Page Inbox / Meta Business Suite". Meta Business Suite Inbox is the same first-party inbox app; Conversation Routing describes "Meta Business Suite Inbox as another application connected to your page".

### Messages sent by our own app

Our echoes carry **our own app ID**, because `app_id` is the app the message was sent from. They also carry back the `metadata` string we set in the Send call.

### Classifying an echo [INFERENCE]

1. `String(message.app_id) === OUR_META_APP_ID`: our own send.
   - Match it to the pending outbound row by `mid` (equal to the `message_id` from the Send API response) or by `metadata`. Put our internal outbound UUID in `metadata`, which must be under 1000 characters.
   - Do not create a duplicate message.
2. `app_id` in {`263902037430900`, `26390203743090`}: a human replied from the Facebook Page inbox, Meta Business Suite or the Messenger app.
   - Insert it as an outbound message with source "page_inbox", authored by "Page (external)".
3. Any other `app_id`: a third-party tool (chatbot, CRM). Insert it as an outbound message with source "other_app:{app_id}".
4. `app_id` missing: treat it as an external send. This case is not documented.

Also read echoes from `entry[].standby[]`.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing

---

## 11. Send API rate limits

**[DOC]** Messenger rate limits page:

> "Calls within 24 hours = 200 * Number of Engaged Users" — "The Number of Engaged Users is the number of people the business can message through Messenger."
>
> Send API: "Your app can make 300 calls per second per Facebook Page for messages that contain text, links, reactions, and stickers." "Your app can make 10 calls per second per Facebook Page for messages that contain audio or video content." "Your app may be rate limited if too many messages are sent to a single thread."
>
> Conversations API: "Your app can make 2 calls per second per Facebook Page."
>
> High volume: "If a Page sends more than 40 messages per second or constantly sends or receives messages in a large number of conversations at the same time, new messages are not displayed in the Page Inbox and the Page cannot send new messages until the volume decreases."

**[DOC]** The Graph rate-limiting page:

- lists Messenger under Business Use Case limits, with error code **80006** and BUC type `messenger`;
- says to watch the `X-Business-Use-Case-Usage` header (`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access` in minutes) and `X-App-Usage`;
- lists throttle codes 4, 17, 32, 613 and 80001 (Pages).

**[INFERENCE]**

- Use a per-Page token bucket: about 10 requests/second for audio and video sends; text is far below 300/second in practice.
- Keep per-thread serialization, one in-flight send per conversation, which also preserves message order.
- Parse `X-Business-Use-Case-Usage` and pause the Page's queue at about 90% usage, or on codes 4, 32, 613 or 80006.
- Use the Conversations API (2 rps per Page) only for backfill, never for live sync.

Sources:

- https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting
- https://developers.facebook.com/docs/graph-api/overview/rate-limiting

---

## Open items to verify in a sandbox

1. Whether the multipart `filedata` upload to `/{PAGE_ID}/message_attachments` works. The doc examples are inconsistent.
2. How long inbound attachment CDN URLs stay valid (observe the `oe=` parameter), and whether `GET /{mid}?fields=attachments` returns a fresh URL.
3. The exact `app_id` in echoes from Meta Business Suite web, the Business Suite mobile app and the Messenger app. We expect 263902037430900.
4. Which outside-window subcode a v26.0 Page send actually returns: 2018278 or 2534022.
5. Whether a successful send with `attachment_id` returns `{recipient_id, message_id}` or `{success}`.
6. Whether Pages owned by a business portfolio appear in `/me/accounts` without `business_management` (section 12e).

---

## 12. Facebook Login: connect Pages with a login instead of a pasted token

Researched: 2026-11-05 (official Meta for Developers pages only).

### 12a. Manual login flow (redirect + code) [DOC]

- Login dialog: `https://www.facebook.com/{version}/dialog/oauth?client_id={app-id}&redirect_uri={redirect-uri}&state={state-param}`. Required: `client_id`, `redirect_uri`, `state`. Optional: `response_type` (`code` is the default; also `token`, `code%20token`), `granted_scopes`, `scope` ("A comma or space separated list of Permissions to request").
- On success the redirect carries `code` and the unchanged `state`. On cancel or error: `YOUR_REDIRECT_URI?error_reason=user_denied&error=access_denied&error_description=Permissions+error.`
- Code exchange (must be server-to-server, because it carries the app secret): `GET https://graph.facebook.com/{version}/oauth/access_token?client_id=…&redirect_uri=…&client_secret=…&code=…`. Response JSON: `access_token`, `token_type`, `expires_in`. The `redirect_uri` "must be the same as the original" one used to open the dialog, and it must be listed in **Valid OAuth Redirect URIs** (Client OAuth Settings).
- `state` "should be used for preventing Cross-site Request Forgery" and is returned unchanged.
- Not documented on that page: code lifetime, single use, `appsecret_proof`.
- **[AMBIGUOUS]** The manual-flow and long-lived-token pages now show **v27.0** samples and "Latest Graph API Version: v27.0", while the versions table still lists v26.0 as the newest. We keep `META_GRAPH_VERSION=v26.0` and build the dialog URL with the same configured version.

Sources:

- https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
- https://developers.facebook.com/docs/graph-api/changelog/versions

### 12b. Long-lived user token and Page tokens [DOC]

- `GET /{version}/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-user-token}` returns `access_token`, `token_type`, `expires_in`. "A long-lived token generally lasts about 60 days."
- With the long-lived user token, query `/{app-scoped-user-id}/accounts` (the Pages API overview uses `/me/accounts`). "The person requesting the token must have a role on the Page." "Long-lived Page access token do not have an expiration date." They can still be invalidated (password change, role removed, app removed), which gives error 190.
- `/{user-id}/accounts` returns "Pages the User has a role on": `data`, `paging`, `summary.total_count`. It adds the field `tasks` ("The User's tasks assigned to the Page"). Page fields such as `access_token`, `name` and `picture` are requested with `fields=`. Paging follows the generic Graph cursor model (`paging.next`).

Sources:

- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- https://developers.facebook.com/docs/graph-api/reference/user/accounts/
- https://developers.facebook.com/docs/pages-api/overview

### 12c. Page tasks: can we message? [DOC + INFERENCE]

Pages API overview task table:

- `MESSAGING` = "Send messages as the Page";
- `MODERATE` = "Respond to comments on Page posts as the Page", and so on;
- `MANAGE` = "Assign and manage Page tasks";
- also `CREATE_CONTENT`, `ADVERTISE`, `ANALYZE`, `MANAGE_LEADS`, `VIEW_MONETIZATION_INSIGHTS`.

"If a person is given Admin access to a Page in the UI, that person is able to perform all tasks on that Page."

Requirements already recorded in sections 5 and 9:

- sending needs a Page token "requested by a person who can perform the `MESSAGE` task" (that is, `MESSAGING`);
- subscribing the Page needs `MODERATE` (Messenger webhooks page), or "CREATE_CONTENT, MANAGE, or MODERATE" (subscribed_apps reference).

**[INFERENCE] Rule used in code:** `canMessage = tasks contains MESSAGING && tasks contains one of {MODERATE, MANAGE, CREATE_CONTENT}`. If Meta omits `tasks`, we allow the attempt and let the real connect call report any error.

### 12d. Facebook Login for Business: `config_id` vs `scope` [DOC]

- The App Dashboard configuration gives a **Configuration ID**. For the manual flow, "include your configuration ID as an optional parameter" (`config_id=…`) in the dialog URL.
- On `scope`: "although scope can still be included, we recommend that you do not use it". The JS SDK page says "`config_id` has replaced `scope`".
- Each configuration picks a token type:
  - **User access token**: "if your app takes actions in real time, based on input from the user";
  - **Business integration system user** token: for automated actions. It needs the code grant with `response_type=code` and `override_default_response_type=true`.
- "Your Meta app must be a business type app or an app with a use case that supports Facebook Login for Business."
- Pages permissions (`pages_messaging`, `pages_show_list`, …) are available for both token types. The configuration also lists the assets to request.

**Implementation:**

- If `META_LOGIN_CONFIG_ID` is set, send `config_id` together with `response_type=code` and `override_default_response_type=true`, and **no** `scope`. The configuration must use the **User access token** type, because our callback exchanges the code for a long-lived user token and then reads `/me/accounts`.
- Otherwise, send `scope=pages_show_list,pages_manage_metadata,pages_messaging` (classic Facebook Login).

Source: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business

### 12e. Permissions and App Review [DOC]

- `pages_show_list`: "allows your app to access the list of Pages a person manages". No dependencies.
- `pages_manage_metadata`: subscribe to Page webhooks and update Page settings. Depends on `pages_show_list`.
- `pages_messaging`: "allows your app to manage and access Page conversations and calling in Messenger". Depends on `pages_manage_metadata` and `pages_show_list`. The review screencast must show a message being sent from the app.
- `business_management`: the Business Manager API. It is **not** listed as a dependency of `pages_messaging`.
  - **[INFERENCE]** We do not request it by default. If Pages owned by a business portfolio do not appear in `/me/accounts`, add it to the Login for Business configuration. This has not been verified.
- Advanced Access (App Review plus Business Verification) is needed for Pages and people that have no role on the app.
  - **[INFERENCE]** In Development mode, only people with a role on the app can log in, and only their Pages are returned.
- The Page picture edge needs `pages_read_engagement` (plus the `MANAGE` task) or the "Pages Public Metadata Access" feature.
  - **[INFERENCE]** We request `picture{url}` in `/me/accounts` and retry without it if Meta rejects the field for a missing permission.
  - The URL is a CDN URL that can expire, so the UI falls back to an avatar with the Page's initial.

Sources:

- https://developers.facebook.com/docs/permissions/reference (entries `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management`)
- https://developers.facebook.com/docs/graph-api/reference/page/picture/

### 12f. appsecret_proof [DOC]

- "The app secret proof is a sha256 hash of your access token, using your app secret as the key" (`hash_hmac('sha256', $access_token, $app_secret)`).
- It is added "as an `appsecret_proof` parameter to each call you make".
- The App Dashboard toggle **Require App Secret** (App Settings → Advanced → Security) makes it mandatory.

**Implementation:**

- The OAuth helpers that use a user token (`/me`, `/me/accounts`) send `appsecret_proof` as a query parameter: the lowercase hex HMAC-SHA256.
- The doc does not state the encoding. Hex is what Meta's SDKs use.

Source: https://developers.facebook.com/docs/graph-api/securing-requests

### 12g. Security decisions [INFERENCE]

- `state` is 32 random bytes (base64url). It is stored in Redis for 10 minutes together with the admin's user id, and consumed once (GETDEL).
- The callback never puts tokens in a URL or a log:
  - it stores a 15-minute "login session" in Redis, with the Page tokens encrypted by `ENCRYPTION_KEY`;
  - it redirects the browser to `/admin/channels?fbSession=<random id>`;
  - only the same admin can read or use that session.

---

## 13. Conversations API (sync of history and missed messages)

Webhooks never deliver history. In Development mode Meta only sends webhooks for people with a role on the app, and webhooks can be lost during Meta outages. So the inbox also **reads** conversations from the Graph API. Everything below was checked on 2026-11-05 against the real Page "Demo app" (id `1373442085851879`) on Graph v26.0, using its Page token and `appsecret_proof`. Only GET requests were made.

Label used here: **[VERIFIED]** = seen in real responses.

### 13a. Requests [VERIFIED]

- `GET /v26.0/{page-id}/conversations?platform=messenger&fields=id,updated_time,message_count,participants&limit=N&after=<cursor>`
- `GET /v26.0/{conversation-id}/messages?fields=id,message,from,to,created_time,attachments{id,mime_type,name,file_url,image_data{url,width,height},video_data{url}},sticker,shares{link,name}&limit=N&after=<cursor>`
- The token goes in the `Authorization: Bearer` header and `appsecret_proof` is sent on every call. Both edges accept `limit=100`.
- A Page token from Facebook Login with `pages_messaging` is enough. The app was in Development mode, yet the API **returned every conversation**, including customers with no app role (Tuấn Kiệt, Cao Hung), with their real names. Webhooks only arrived for Đúng Văn, who has a role.
- Leaving out `platform=messenger` also worked for a Page. We always send it.

### 13b. Response shape [VERIFIED]

- **Conversation:**
  - `id` = `t_<digits>`.
  - `updated_time` = `"2026-11-05T15:00:20+0000"`, precise to the second.
  - `participants.data` = `[{name, email: "<id>@facebook.com", id}]`: the customer first, then the Page.
  - Other fields that work: `message_count`, `unread_count`, `snippet`, `link`, `can_reply`.
- **Message:**
  - `id` = `m_...`.
  - `message`: an empty string when there is no text.
  - `from` = `{name, email, id}`.
  - `to.data` = `[{name, email, id}]`.
  - `created_time`: to the second. Webhook `timestamp` is in milliseconds.
  - `tags.data` (for example `inbox`, `sent`, `source:web`): **not** a reliable way to recognise our own app. Messages sent with our Send API still showed `source:web`.
- **Order:** newest first on both edges.
- **Paging:**
  - `paging.cursors.{before,after}` are always present.
  - `paging.next` is present **only when there is another page**.
  - `next` points at **v27.0**, a newer version than the one we requested. When the token is sent in the header, `next` does not contain it. We still follow `cursors.after` and never `next`.
- **Errors:** a bad conversation id gives HTTP 400 `{code: 33, error_subcode: 1893013, type: OAuthException}`. The message is localised to the token owner's language (Vietnamese here), so match on codes, never on text.

### 13c. Ids match webhook and Send API [VERIFIED]

This is the critical point: sync and webhook map to the **same** identity and message.

- **Participant `id` / `from.id` = PSID.**
  - Đúng Văn's participant id `39840294375585055` equals `contact_identities.external_user_id` that the webhook stored.
  - The Page's id is the page id.
  - No mapping is needed.
- **Message `id` = webhook `mid`** (`m_3BlS8y2M…` for the customer message) **= Send API `message_id`.**
  - The 6 messages we sent (`m_71vb5M6…`, `m_vsmVGzh…`, `m_9EPQBhw…`, `m_oU5W3CK…`, `m_MibYUYw…`, `m_csqDqVP…`) came back with the same ids.
  - So `(channel_account_id, external_message_id)` dedupes sync against both webhook and outbound.
- `message_count` counted 7 messages. The 2 messages that failed locally were never sent, so they are not on Meta.

### 13d. `since` is ignored [VERIFIED]

- `since=<unix>` on `/conversations`: a conversation updated before the cutoff was still returned.
- `since=<unix>` on `/messages`: all 8 messages were returned.
- **Implementation:** filter on our side. Both lists are newest first, so we stop paging at the first item older than the cutoff.

### 13e. Content types

- **[VERIFIED] Link shares:**
  - `message` holds the URL text.
  - `shares.data = [{link: "https://l.facebook.com/l.php?u=<encoded>&h=…", name: "<page title>", id: <mid>}]`.
  - The link goes through Facebook's redirect. We keep the text when there is any. Otherwise we write `[Liên kết] <name> — <unwrapped u= link>`.
- **[DOC, not seen on the test Page]** Images, video, files and stickers:
  - `attachments.data[]` = `{id, mime_type, name, size, image_data{url,width,height,preview_url,…} | video_data{url,…} | file_url}`.
  - `sticker` = the sticker image URL (a string).
  - Mapping:
    - `image_data` → image;
    - `video_data` → video;
    - `file_url` → type by `mime_type` (audio/video/image/file);
    - `sticker` → sticker.
  - The test Page has no such messages yet. Verify when one arrives.
- **[VERIFIED]** The API returned no `app_id` or `metadata`, so a message we sent cannot be recognised by app. See 13f.

### 13f. Recognising our own sent messages [INFERENCE]

- A message we sent and stored with `external_message_id = message_id` deduplicates by id.
- **One send can produce several Meta messages:** text plus each file. `messages.external_message_id` only keeps the first id. So the outbound pipeline now records the mid of **every** successful part in `messages.raw.sentExternalIds`. Echoes of our own app (identified by metadata) do the same. A synced Page message whose id is in that list is skipped.
- **Race:** Meta may have the message before the worker has saved the Send API result. A synced Page message is skipped when the same conversation has an outgoing message that is still `queued`, has the same text (attachment-only parts match any queued message), and is within ±10 minutes.
- Any other Page message is imported as `agent` with no `senderUserId`, labelled "Meta Business Suite": replies from Business Suite, other tools, or history from before connection.

### 13g. Sync policy [INFERENCE]

- **Backfill:**
  - Runs after connecting a Page and from the admin button.
  - Covers conversations with `updated_time` in the last N days (`MESSENGER_HISTORY_DAYS`, default 30) and their messages in the same window.
  - Limits: 500 conversations, 200 newest messages per conversation.
  - Messages are processed oldest first.
  - It does not raise `unread_count`, does not reopen resolved conversations, and emits one `conversation.updated` per conversation instead of `message.created` per message.
- **Incremental:**
  - Runs every `MESSENGER_SYNC_INTERVAL_SEC`.
  - Reads conversations with `updated_time >= lastSyncedAt - 2 min` (the last 24 h if never synced) and their messages since then.
  - Behaves like a webhook: unread++, reopen, `message.created`.
- **Names:** the participant `name` is passed as the profile hint, so placeholder names ("Khách Messenger …1234") are replaced by real names. Names edited by staff are not overwritten.
- **Errors:**
  - Token errors (190/102, OAuth subcodes) mark the channel `expired`.
  - Errors 10 and 200–299 mean "cannot read conversations".
  - Rate limits and 5xx are transient.
  - Status is stored in `channel_accounts.settings.sync`.

Sources: https://developers.facebook.com/docs/graph-api/reference/page/conversations/, https://developers.facebook.com/docs/graph-api/reference/conversation/messages/, https://developers.facebook.com/docs/graph-api/reference/message/ and the real calls above.
