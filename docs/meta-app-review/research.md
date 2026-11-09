# Meta Business Verification, App Review and Live mode for "Dezon Inbox": verified requirements

Researched: 2026-11-05. App: **Dezon Inbox**, App ID `1727184952398550`, app type **Business**, currently "Development" ("Phát triển").

Only official Meta sources were used:

- developers.facebook.com. Most pages were read from their raw `.md` copies under `/documentation/...`.
- Meta Business Help Center (facebook.com/business/help), rendered in a browser.
- Meta Platform Terms.

Quotes are copied from the live pages on the date above.

Labels:

- **[DOC]**: the official page says this. The quote follows.
- **[INFERENCE]**: our reading or recommendation. No page states it outright.
- **[AMBIGUOUS]**: pages disagree with each other, or with what the owner sees in the dashboard.
- **[UNVERIFIED]**: we could not find an official source for this.

Meta moved most developer docs from `/docs/...` to `/documentation/...` (for example, `/docs/app-review` → `/docs/resp-plat-initiatives/app-review` → `/documentation/resp-plat-initiatives/individual-processes/app-review`). Old links redirect.

---

## 0. Short answer for the owner

1. **App Review cannot be skipped for Dezon's use case.**
   - Staff who log in can be covered by app roles.
   - Customers who message the Pages cannot.
   - Receiving their messages, reading their conversations and reading their name/avatar all need **Advanced Access**.
   - Advanced Access needs **Business Verification + App Review**. See §4.
2. **Order of work:**
   1. Business Verification of Dezon in Meta Business Suite → Security Center (up to 14 business days).
   2. Connect the app to the verified business portfolio (App Dashboard → Settings → Basic → Verification).
   3. Fill in the app settings: icon 1024×1024, privacy policy URL, data-deletion URL, category, app purpose, contact email.
   4. Make at least one successful API call per permission within the last 30 days.
   5. App Review submission: per-permission description plus a screen recording (English UI or captions), and test instructions and credentials for a publicly reachable HTTPS URL.
   6. Data handling questions.
   7. Decision, usually 2–7 days.
   8. Switch to Live / confirm Advanced Access is active.
3. **What to request:**
   - `pages_messaging`, `pages_manage_metadata`, `pages_show_list`: Advanced Access.
   - `pages_read_engagement`: Advanced Access. The Conversations API docs list it.
   - Feature **Business Asset User Profile Access**: customer name and avatar.
   - Feature **Human Agent**: optional, for staff replies from 24 hours up to 7 days.
   - `public_profile`: Advanced Access. Required for Facebook Login for Business apps before go-live.
   - **Do not request** anything not used today (no `business_management` unless proven needed, no AI-related features).

---

## 1. Business Verification (Vietnamese company)

### 1.1 Why it is needed

- **[DOC]** "Business Verification is required to get Advanced Access. In some cases additional App Review on an individual permission and feature basis might be required."
  - Source: https://developers.facebook.com/docs/graph-api/overview/access-levels
- **[DOC]** "Starting in 2023, your business must go through business verification and be verified in order to complete app review."
  - Source: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content
- **[DOC]** The Human Agent and Business Asset User Profile Access feature pages both say: "This permission or feature is only available with business verification."
  - Sources: https://developers.facebook.com/docs/features-reference/human-agent and https://developers.facebook.com/docs/features-reference/business-asset-user-profile-access
- **[DOC]** "While verification is not required to Go Live, you will not be able to access data you do not own until verification is complete."
  - Source: https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings
- **[DOC]** (Meta blog, 9 Oct 2026, "Retiring Access Verification for Tech Provider Apps"): "Business Verification is still required before your app can access data owned by other businesses." and "App Review is still required for advanced permissions, and the review standards for those permissions are unchanged."
  - Source: https://developers.facebook.com/blog/post/2026/10/09/retiring-access-verification-for-tech-provider-apps/
  - The separate "Access Verification" (Tech Provider) step is **gone**: "Access Verification is no longer required."
  - Source: https://developers.facebook.com/documentation/development/release/access-verification

### 1.2 Where to start (two entry points; both end in Meta Business Suite)

**A. From Meta Business Suite (recommended; start here first)** [DOC]

> "Go to Security Center in Meta Business Suite. If you cannot access Security Center, then you may not have full control of the business portfolio. Click Start verification."
>
> "Business portfolio owners with full control can verify their business in Meta Business Suite."

Source: https://www.facebook.com/business/help/2058515294227817

Steps as written on that page:

1. "Provide your business details, including the legal business name, address, phone number and website. Check that the details you enter exactly match the details of your legal business entity. Also make sure your business website loads and is HTTPS compliant…"
2. "Confirm your business details. If no matching record is found, then you can select My business isn't listed or None of these match. In this case, you may be asked to upload official documents, such as a business license or articles of incorporation…"
3. "Choose a method to confirm your connection: email, phone, text message, WhatsApp message or domain verification."
4. "Confirm your connection, then click Done."
5. "A decision on your verification submission may take up to 14 business days."
6. "Note: If you edit your business details, then you need to complete the verification process again."

- **[DOC]** If the page shows "Ineligible for verification", you do not need to verify in Security Center. You may instead be notified "from a platform other than Security Center". (Same source.)
- **[DOC]** Business Verification "is different from Meta Verified for businesses and won't give you a verified badge." (Same source.)

**B. From the App Dashboard (connects the app to the business)** [DOC]

> "Load your app in the App Dashboard and go to **Settings** > **Basic** > **Verification** and click the Start Verification button…"
>
> "You can use the App Dashboard to connect your app to a Business that you're an Admin of, regardless of whether or not the Business has been verified, but the verification process itself must be completed in the Facebook Business Manager."
>
> "anyone with an Administrator role on your app can connect it to a Business, but only someone with an Admin role in the Business will be able to complete the verification process."
>
> "Once you have completed verification, return to the Basic Settings panel. You should see that your app is now connected to a verified Business."

Source: https://developers.facebook.com/documentation/development/release/business-verification

- In the Vietnamese dashboard this is **"Cài đặt ứng dụng → Thông tin cơ bản → (mục) Xác minh"**.
- **[INFERENCE]** The exact Vietnamese labels inside that section were not verified.

**[DOC]** After the app is linked to a business portfolio, roles move to Business Manager: "If your app is connected to a business portfolio, you must use the Business Manager to manage roles for your app."

Source: https://developers.facebook.com/documentation/development/build-and-test/app-roles

### 1.3 Accepted documents (applies to Vietnam)

Source for all quotes below: https://www.facebook.com/business/help/159334372093366

- **[DOC]** "The documents you upload to verify your business should validate the legal name of your business and your business's official mailing address or phone number."
- **[DOC]** Primary document types:
  - "Certificate/Articles of Incorporation."
  - "Business Registration or License Document."
  - "Government Issued Business Tax Document: This could include a Tax Certificate. Self-filed tax documents are not accepted."
  - "Business Bank Statement."
  - "Utility Bill: A utility bill is accepted only for Business Address and Phone number. The Legal Business Name must be on the utility bill. A utility bill is not an acceptable document for Legal Business Name verification."
- **[DOC]** "Make sure the documents you upload for business verification are not expired and are issued by the relevant authorities."
- **[DOC]** **Vietnamese is a supported language.** It appears in the list. Otherwise: "use English translations with official stamps of a translating agency."
- **[DOC]** "You may also be asked to provide proof of website domain ownership if you choose to receive a verification code at your email address."
- **[INFERENCE]** For Dezon:
  - Use the **Giấy chứng nhận đăng ký doanh nghiệp** (Business Registration document). It proves the legal name, the address and the tax code (mã số doanh nghiệp).
  - Add a utility bill or bank statement only if the phone or address must be proven separately.
  - The legal name typed into the form must match the certificate **exactly**, including "CÔNG TY TNHH/CỔ PHẦN …".
  - The phone, address and website (https://dezon.vn) must match the certificate or the website.
  - Cover any personal ID numbers on the scans (the page asks to cover personal information that is not needed).

### 1.4 Confirmation methods and domain verification

- **[DOC]** "You'll need to be able to receive a verification code sent to the phone number or email address of your business, or verify your business portfolio's domain."
  - Source: https://www.facebook.com/business/help/1095661473946872
- **[DOC]** Domain verification:
  - Path: "Go to Domains in the Brand safety section of Meta Business Suite's Settings… Enter in the root domain without any prefixes. For example, enter website.com".
  - Methods: a meta-tag in the home page `<head>`, an HTML file in the root directory, or a DNS TXT record.
  - Requirements: "You must have full control of the business portfolio" and "admin or developer access to your domain."
  - "Once your domain has been verified, you can remove the meta-tags, DNS TXT records and HTML files and it won't impact your verification status."
  - Source: https://www.facebook.com/business/help/321167023127050
- **[INFERENCE]** The easiest choice is an email code sent to an `@dezon.vn` address together with domain verification of `dezon.vn`. That proves both the email and the website at once. A DNS TXT record avoids editing WordPress.

### 1.5 Common rejection reasons (Business Verification)

Source: https://www.facebook.com/business/help/2342133782492969

**[DOC]** Rejection reasons include:

- "Submitting, or being suspected of submitting, false or misleading information."
- "Attempting to claim or verify a business portfolio you don't own or have authorization to represent."
- "Trying to circumvent Meta's verification review system."
- "Having a website that fails to load, is not HTTPS compliant (does not use a secure connection) or contains a link that leads to an error message."

Same source: "If your verification application was rejected, you may be eligible to appeal."

### 1.6 Duration

- **[DOC]** "A decision on your verification submission may take up to 14 business days." (https://www.facebook.com/business/help/2058515294227817)
- **[DOC]** Verified businesses can have more testers: "An app that is linked to a Business Manager with Business Verification can have up to a combined total of 500 analytics users and testers. Most apps, not linked, can have up to 50 testers." (https://developers.facebook.com/documentation/development/build-and-test/app-roles)

---

## 2. App Review

### 2.1 What needs review, and what is automatic

**[DOC]** Access levels:

> "All Business, Consumer, and Gaming apps are automatically approved for Standard Access for all permissions and features. Advanced Access, however, must be approved on an individual permission and feature basis through the App Review process."
>
> "Permissions with Standard Access can only be requested from app users who have a role on the requesting app. Similarly, features with Standard Access are only active for app users who have a role on the app."
>
> "Business and Gaming apps created before February 16, 2021 were automatically approved for Advanced Access for the email and public_profile permissions…"

Source: https://developers.facebook.com/docs/graph-api/overview/access-levels

Dezon Inbox was created in 2026, so nothing is auto-approved at Advanced level.

| Item                                           | Why Dezon needs it                                                                     | Standard (auto, role users only) | Advanced (needs Business Verification + App Review)                                                                                          | Source                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pages_messaging`                              | Receive and send Page messages; Conversations API                                      | yes                              | **Required**                                                                                                                                 | permissions ref; Messenger webhooks: "Advanced Access to receive notifications from your customers…"      |
| `pages_manage_metadata`                        | Subscribe the Page to webhooks (`/subscribed_apps`); dependency of `pages_messaging`   | yes                              | **Required**                                                                                                                                 | permissions ref                                                                                           |
| `pages_show_list`                              | List the Pages a staff member manages at connect time; dependency                      | yes                              | **Required**                                                                                                                                 | permissions ref                                                                                           |
| `pages_read_engagement`                        | Listed by the Conversations API docs for Messenger                                     | yes                              | **Request it** (see 2.2)                                                                                                                     | Conversations API doc                                                                                     |
| Business Asset User Profile Access (feature)   | Customer name and avatar (User Profile API)                                            | yes                              | **Required** for non-role customers                                                                                                          | feature ref: "Requires App Review."                                                                       |
| Human Agent (feature)                          | `HUMAN_AGENT` tag, staff replies up to 7 days                                          | n/a                              | **Requires App Review + Business Verification**                                                                                              | feature ref                                                                                               |
| `public_profile`                               | Facebook Login for Business                                                            | auto-granted                     | **Required before go-live** for Facebook Login for Business                                                                                  | FL4B FAQ                                                                                                  |
| `business_management`                          | Only if Pages owned by the business portfolio fail to appear                           | —                                | do not request unless proven                                                                                                                 | permissions ref                                                                                           |

**[DOC]** quotes for the table:

- `pages_messaging`: "allows your app to manage and access Page conversations and calling in Messenger. … The allowed usage for this permission is to create user-initiated interactive experiences, send customer support messages, confirm bookings or purchases and orders, and facilitate calls between a business and its customers." Dependencies: `pages_manage_metadata`, `pages_show_list`.
- `pages_manage_metadata`: "allows your app to subscribe and receive webhooks about activity on the Page, and to update settings on the Page."
- `pages_show_list`: "allows your app to access the list of Pages a person manages." Also: "If the `pages_show_list permission` is requested as a dependency of another main permission, please specify the main permission in the use case description."
- `pages_read_engagement`: "allows your app to read content (posts, photos, videos, events) posted by the Page, read followers data (including name, PSID), and profile picture, and read metadata and other insights about the Page."
- `public_profile`: "This permission is automatically granted to all apps."
- Source for these five: https://developers.facebook.com/documentation/development/permissions (raw: same URL + `.md`)
- Business Asset User Profile Access: "Requires App Review. The Business Asset User Profile Access feature allows your app to read the User Fields for users engaging with your business assets such as id, ids_for_business, name, and picture." (https://developers.facebook.com/docs/features-reference/business-asset-user-profile-access)
- User Profile API: "To retrieve a user's profile information, you need to have Advanced Access for the Business Asset User Profile Access feature." (https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile)
- Human Agent: "The Human Agent feature allows your app to have a human agent respond to user messages using the human_agent tag within 7 days of a user's message. … Examples include when the business is closed for the weekend, or if the issue requires more than 24 hours to resolve." Also: "This permission or feature requires successful completion of the App Review process before your app can access live data." (https://developers.facebook.com/docs/features-reference/human-agent)
- `public_profile` for Facebook Login for Business: "**Is advanced access to the public_profile permission required before a Facebook Login for Business app goes live?** Yes, advanced access to the `public_profile` permission is required for Facebook Login for Business apps before they go live." Also: "The `email` and `public_profile` permissions are supported, but they can't be requested on their own." (https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- **[UNVERIFIED]** Whether Advanced Access for `public_profile` needs a full screencast review or is a one-click "Get advanced access" once the business is verified. No current official page says which. Plan to include it in the same submission. If the dashboard offers one-click access, take it.

### 2.2 `pages_read_engagement` and the Conversations API

- **[DOC]** "For Messenger conversations between people and your Page, your app will need: Page access token requested by a person who can perform the `MESSAGING` or `MODERATE` task on the Page; The `pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging` permissions."
- **[DOC]** "Advanced Access is required to access conversations between your business and people who do not have a role on your messaging app, your Instagram Professional account, your Facebook Page, or your business."
- Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversations (also https://developers.facebook.com/docs/graph-api/reference/page/conversations/)
- **[AMBIGUOUS]** On 2026-11-05 our Development-mode app read all conversations, including non-role customers, with only `pages_messaging` (see `docs/research/messenger-platform.md` §13). The docs say Advanced Access plus `pages_read_engagement` are needed. **Do not rely on the observed behaviour.** Request `pages_read_engagement` and show the history sync in the screencast.
- **[DOC]** The screencast for `pages_read_engagement` asks to "Demonstrate how your app user accesses a post's content on their Facebook Page" (permissions reference). That does not fit an inbox.
  - **[INFERENCE]** In its description, say plainly that it is requested because the Conversations API requires it, and that the app uses it to read Page conversation history and participant names. Show the "Đồng bộ lịch sử" (history sync) action in the recording. Reviewers may still question it. If it is rejected, the app can still work on webhooks plus the User Profile API.

### 2.3 Before submitting (checklist from the submission guide)

Source: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide

**[DOC]**

- "Make sure we can access your app or website. Your app must be publicly available or you must provide instructions on how to access it."
- "Upload a 1024x1024 compliant app icon image to **Settings** > **Basic** > **App Icon**."
- "Make at least 1 successful API call using each permission for which you are requesting advanced access. Calls must be made within 30 days of submitting for App Review…"
- "Note that the **Request advanced access** button will remain grayed out until a successful API has been logged in our system. … The API call data will be logged within 2 days of your successful API call."
- "Read the **Allowed Usage** section in the reference for each permission and feature… If your app does not satisfy the allowed usage for a permission or feature, your app will not be approved for that permission or feature."
- "Making changes to your app's basic or advanced settings after you have submitted may require re-review."

**[DOC]** Messenger-specific requirements (https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review):

- "Publish the Facebook Page associated with your app."
- "Ensure your webhook is functioning as expected and returning a `200 OK` response to webhook events within 20 seconds." (The webhooks page asks for 5 seconds or less; we already reply at once.)
- "If your app has gated functionality or content, provide a way for the Meta review team to access and test it. For example, if a feature requires a user to log in to your service, be sure to provide a username and password in the submission notes."
- Subscribe to `messaging_policy_enforcement` webhook events ("You receive notifications here if your Messenger app violates a Platform policy").

### 2.4 Submission steps (dashboard: "Xét duyệt ứng dụng")

Source: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide

**[DOC]**

1. "Go to the **App Review** > **Permissions and Features** tab." Click **Request advanced access** for each item ("Nhận quyền truy cập nâng cao"). "**Only request the permissions and features that your app needs**."
2. "Step 1.5: Complete Business Verification": you may be prompted.
3. "Step 2: Answer Data Handling Questions": "Your responses to these questions will be immediately evaluated and could take up to 30 seconds."
4. "Step 3: Complete App Settings": icon, Privacy Policy URL, **App Purpose**, App Category, Primary Contact.
   - App Purpose: "Set this to **Yourself or your own business** if your app is only available to people who have a role on your app, or a role in a Business that has claimed your app. Otherwise set it to **Clients**."
   - **[INFERENCE]** Dezon: "Yourself or your own business". Only Dezon staff log in, and they will have roles in Dezon's business portfolio.
5. "Step 4: Complete App Verification": "describe how we can access your app in order to test it. We will test your app using our own test accounts. **Do not include your _personal_ Meta Technologies app account's credentials.**"
6. "Step 5: Complete Usage Descriptions": "Each permission and feature must have its own description. **Do not copy and paste.**" Upload one screen recording per item.
7. "Step 6: Submit For Review": agree to the Platform Onboarding Terms. "you should receive a decision within a week."

The guide suggests these questions for each description:

- "How does this permission/feature help my app users?"
- "Why does my app need this permission/feature?"
- "How does my app use the data that this permission/feature provides access to?"
- "Why would my app be less useful if it did not have this permission/feature?"

**[DOC]** Known doc bug: in the permissions reference, the `pages_messaging` "Use Case Description" prompt reads "Provide specific examples of why your app requires creating and managing ads on behalf of other businesses for their pages." It was copied from an ads permission. Write a messaging use case anyway.

### 2.5 Screen recording (screencast) requirements

**[DOC]** Source: https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings

- "Your submission must include screen recordings that demonstrate how to use your app to test every permission and feature in your submission."
- **Language:**
  - "**Use English as the app UI language** – If possible, please set the app UI language to English before recording…"
  - "**Provide captions and tool-tips** – If your app is not available in English… provide captions and tool-tips to explain what is happening on screen."
  - "**Explain the meaning of buttons and other UI elements**".
- **Login flow:** "Before you start a recording, log out of any test accounts you are using. Capture the entire login flow, from logged-out to logged-in. If your app users can create accounts and log into your app without the use of a Meta Login product, also capture this flow."
- **Permission granting:** "show how your app user will use a business login button (if you have implemented Facebook Login for Business…) and the app user granting your app the permission you are demonstrating. Then, show the app user using the app functionality that requires that permission."
- **Data usage:** "For each permission and feature in your submission, show an app user accessing data that requires the permission or feature and show what your app does with that data."
- **Format tips:**
  - "Record in high-resolution, ideally 1080 or better."
  - "Decrease your monitor's resolution to a width of 1440 or less."
  - "Omit audio; our reviewers will not listen to it."
  - Use annotations and zoom; increase the cursor size.
- "Recordings do not need to explain why your app needs each of them, the App Review submission form will ask for this information."
- **[UNVERIFIED]** No official current page gives a maximum length or file format. Keep each video short (about 2–5 minutes) and use MP4. This is an inference.

**[DOC]** Per-permission recording requirements (permissions reference):

- **`pages_messaging`:**
  - "Demonstrate the complete Facebook login process on your app platform, showing how your app user grants your app this permission."
  - "Demonstrate your app sending a message to a Messenger user, and demonstrate the Messenger inbox client (either web or mobile app) receiving and displaying the sent message."
  - "Generate a cURL request that you can integrate into your app platform to send a message; You may use the API Integration Helper in Meta App Dashboard > Messenger to do this."
  - "Make sure it is a recording of the message being sent from the app to the user, instead of sharing screenshots of messages received on Messenger client."
- **`pages_manage_metadata`:** "Demonstrate how your app user subscribes to webhook events or updates the settings of their Facebook Page on your app platform".
- **`pages_show_list`:** "Showcase that the pages owned by the user are successfully connected with your app platform."
- **`pages_read_engagement`:** see §2.2.

**[INFERENCE]** Recommended single storyboard, reusable for each item and trimmed per permission:

1. Logged out → Dezon Inbox login (staff account) → Admin → Channels → "Kết nối Facebook" → Facebook Login for Business dialog → select Pages → grant → the Pages appear as connected (`pages_show_list`) and "Webhook: subscribed" (`pages_manage_metadata`).
2. On a phone, a test person sends a message to the Page in Messenger → it appears in the Dezon Inbox with the customer's name and avatar (Business Asset User Profile Access).
3. A staff member types a reply in Dezon Inbox → the phone's Messenger shows it (`pages_messaging`).
4. History sync shows older conversations (`pages_read_engagement`).
5. Human Agent: a conversation older than 24 hours → the composer shows "Human Agent (7 days)" → a staff member sends → the message arrives.
6. Use English captions throughout. Ideally switch the UI to English if an i18n toggle exists. Otherwise overlay captions on every Vietnamese label.

### 2.6 Reviewer access: test credentials and public HTTPS

- **[DOC]** "If we are unable to access your app to test it, your entire submission will be rejected." (https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)
- **[DOC]** "If we can't access your app for any reason, your entire submission will be rejected, so make sure your app is working and is publicly accessible before submitting." (https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes)
- **[DOC]** "Your app must be publicly available or you must provide instructions on how to access it." (submission guide)
- **[DOC]** "If your app users are able to create accounts and log in to your app without the aid of Facebook Login, we recommend that you include credentials for one of these test users as well." (screen recordings guide)
- **[DOC]** For a private network: "If your test app is on a private network or you want us to test with a specific test user, include any credentials we may need in order to test it properly." (https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction)
- **[DOC]** "You used a fake account. Fake accounts violate our terms and policies, so if you created a fake Facebook account and included its login details in your submission, your entire submission will be rejected." (common mistakes)
- **[INFERENCE] What Dezon must provide:**
  - A **public HTTPS URL**, for example `https://inbox.dezon.vn`, with a valid certificate. Self-signed certificates are not supported for webhooks. The site must not be geo-blocked or behind a VPN or IP allow-list during review.
  - A **reviewer staff account** (email + password) in Dezon Inbox with the role "agent" or "admin", so reviewers can open Admin → Channels.
  - Step-by-step written instructions in English:
    - which Page is already connected (for example "Dezon Inbox Demo");
    - "send a message to m.me/<page>" so they can trigger an inbound message;
    - how to reply and where to see it;
    - how to trigger the connect flow.
  - Do **not** give a personal Facebook password. Meta tests with its own accounts.
  - **[UNVERIFIED]** Whether reviewer accounts can complete Facebook Login for Business on a Page they do not manage. The recording plus the pre-connected Page cover this.

### 2.7 Common rejection reasons (relevant to a Messenger inbox)

**[DOC]** From Common Mistakes (https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes):

- "Your app is inaccessible".
- "A screen recording of a permission or feature is missing".
- "You are still developing your app. … If your app appears incomplete or that you are still making changes to it, your submission will be rejected."
- "You are requesting a permission or feature you might need later".
- "Facebook Login is not working or can't be located. … If we are unable to locate Facebook Login, or are unable to log into your app with Facebook Login, your entire submission will be rejected."
- "You used a fake account".

Also [DOC]:

- "Selecting unneeded permissions is a common reason for rejection during app review." (permissions reference)
- App name and icon rules: "Do not use names that include Facebook or FB…" and "Do not use or incorporate any of our logos, trademarks, icons…" (basic settings).
  - "Dezon Inbox" is fine.
  - The icon must not show the Messenger or Facebook logo.

**[INFERENCE]** Messenger-inbox-specific pitfalls:

- the video shows screenshots instead of a live send;
- the Messenger client receiving the message is not shown;
- Vietnamese UI with no captions;
- the login flow is not shown from logged out;
- `pages_read_engagement` is not justified;
- the Human Agent use is not clearly tied to human replies (never automated);
- the privacy policy is unreachable, or its domain differs from the app's.

### 2.8 Data Use Checkup and data handling questions

- **[DOC]** "Apps that have Advanced Access for a permission or feature must complete Data Use Checkup, which is an annual process to certify that the app accesses Facebook APIs, products, and data in compliance with our Platform Terms and Developer Policies." (access levels)
- **[DOC]** "developers do not need to complete DUC while the app is in Development mode, but will need to complete DUC before the app can be switched to Live mode." (https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-use-checkup)
- **[DOC]** To complete it you must:
  - certify allowed usage;
  - certify compliance with the Platform Terms and Developer Policies;
  - "Answer questions about your data handling practices";
  - "Provide testing instructions for your application."
  - (Same source.)
- **[DOC]** Data handling questions "are designed to validate that personal data received from Meta will be processed and transferred securely… It is recommended that you consult with legal, policy, and privacy experts within your organization". (https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-handling-questions)
- **[INFERENCE]** Have ready:
  - the data processors: VPS host, S3-compatible storage provider, and the LLM provider later when AI ships;
  - the countries of storage (Vietnam or Singapore);
  - whether data is shared with authorities (policy);
  - encryption at rest of Page tokens;
  - access control (staff only);
  - retention: raw payloads purged after 90 days (planned for Phase 1D, not implemented as of 2026-11-05), and customer deletion on request (no deletion feature yet; manual process needed).

### 2.9 Timelines

- **[DOC]** "It typically takes us less than one week to process your submission, and often takes only 2–3 days, but may take longer during peak periods." (https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction)
- **[DOC]** "you should receive a decision within a week." (submission guide)
- **[INFERENCE]** Realistic total:
  - Business Verification: 2 days to 3 weeks.
  - API calls logged: up to 2 days.
  - Review: 2–7 days, plus another cycle if rejected.
  - Plan for 2–5 weeks in total.

---

## 3. Switching to Live ("Chính thức")

### 3.1 Required app settings

Source: https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings

| Field (Settings → Basic / "Thông tin cơ bản") | Required? [DOC wording]                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display Name                                  | "This field is required to switch your app to Live mode."                                                                                                                                                                                                                                                                                                                                                   |
| Contact Email                                 | "This field is required to switch your app to Live mode."                                                                                                                                                                                                                                                                                                                                                   |
| Privacy Policy URL                            | The Basic Settings page does not mark it as Live-required, but the **Platform Terms require it**: "This URL must also be disclosed in the privacy policy field in the settings of your App Dashboard." App Review also requires it in "Complete App Settings".                                                                                                                                              |
| Terms of Service URL                          | "This field is required to switch your app to Live mode." **[AMBIGUOUS]** In practice the dashboard often treats it as optional. Provide one anyway (a simple Terms page on dezon.vn).                                                                                                                                                                                                                      |
| User Data Deletion                            | "links to explicit instructions for your app users on how to delete their data from your app. This URL may be the relevant section in the application's Privacy Policy." **[INFERENCE]** The dashboard usually blocks Live until either the instructions URL or the callback URL is set.                                                                                                                  |
| App Icon                                      | "This field is required to switch your app to Live mode." The submission guide says the icon is 1024×1024.                                                                                                                                                                                                                                                                                                 |
| Category                                      | "This field is required to switch your app to Live mode."                                                                                                                                                                                                                                                                                                                                                   |
| App Purpose                                   | "This field is required to switch your app to Live mode."                                                                                                                                                                                                                                                                                                                                                   |
| Business Verification                         | "While verification is not required to Go Live, you will not be able to access data you do not own until verification is complete."                                                                                                                                                                                                                                                                        |
| Platform / Site URL                           | "You will also need to provide the platforms that your app will be available on (website, iOs store, etc.) This step is necessary to submit your app for App Review." (https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content)                                                                                                                       |

### 3.2 Privacy policy content (Platform Terms §4)

Source: https://developers.facebook.com/terms (Last updated February 3, 2026)

**[DOC]**

- "You will provide, maintain, and comply with a privacy policy that is available through an active, publicly available, easily accessible (including by our crawlers), and non-geoblocked URL."
- "Your privacy policy must clearly explain what data you are Processing, how you are Processing it, the purposes for which you are Processing it, and how Users may request deletion of that data. The right to request deletion must be available to all Users who can access your App."
- "You may only Process Platform Data as clearly described in your privacy policy…"
- Platform Terms §3: "give Users an easily accessible and clearly marked way to ask for their Platform Data to be modified or deleted."
- Platform Terms §5.a: every Service Provider (hosting, storage, and future AI vendor) must agree in writing to process Platform Data "solely for you and at your direction".

**[INFERENCE]**

- Host the policy on `https://dezon.vn/...`. It must not be geo-blocked, and it is better if it is not behind a cookie wall.
- Write it in Vietnamese with an English version (reviewers read English).
- It must also meet **Decree 13/2023/NĐ-CP**. That is not a Meta source; get Vietnamese legal advice.
- Mention the planned AI auto-replies honestly as a future processing purpose, or update the policy when the feature ships.

### 3.3 Business app type and app modes

- **[DOC]** "Business apps do not have app modes and instead rely exclusively on access levels to determine who can grant them permissions and who will be affected by features." (https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/app-types)
- **[DOC]** "Note that apps that have been typed as Business apps do not have app modes and instead rely on access levels. To release new reviewable functionality for a Business app, test the new permissions and features that you need with any user who has a role on the app itself or claimant business and then request Advanced Access…" (https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction)
- **[DOC]** Yet other current pages talk about "Live" for these apps:
  - Messenger webhooks prerequisites: "Publish your Meta app" (https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks).
  - Facebook Login for Business FAQ: "required for Facebook Login for Business apps before they go live".
  - Data Use Checkup: "before the app can be switched to Live mode".
- **[AMBIGUOUS]** The owner's dashboard shows "Chế độ của ứng dụng: Phát triển / Chính thức" for this Business app, so the toggle exists in today's UI even though the App Types page says it does not. **[INFERENCE]** Treat both as gates:
  1. Get Advanced Access approved.
  2. Then flip the toggle to "Chính thức".
- **[DOC]** Generic warning about switching too early: "Apps in Live mode can only request approved permissions from app users, and only approved features will be active for app users. This restriction applies to everyone, even users who have a role on the app itself, so switching to Live mode prematurely may make your app unusable for users who have a role on your app." (submission guide)

### 3.4 Do non-role customers need Advanced Access? Yes (confirmed)

- **[DOC]** "**Standard Access** to receive notifications from people who have a role on your app, such as your app admins, developers or testers; or **Advanced Access** to receive notifications from your customers, people who do not have a role on your app. Requires App Review." (https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
- **[DOC]** "If your app will be used by people who do not have a role on it, the permissions and features that your app requires will need Advanced Access." (access levels)
- This matches what we saw: webhooks arrived only for the role user (Đúng Văn), not for Tuấn Kiệt or Cao Hung.

---

## 4. Can an internal tool for Dezon's own Pages avoid App Review?

**Short answer: no. Staff can be covered by roles. Customers cannot.**

- **[DOC]** App Review is not needed when only role users use the app: "If your app will be used by anyone without a Role on the app or a role in a Business that has claimed the app, it must first undergo App Review. If your app will only be used by app users who have a role on the app itself, App Review is not required." (https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)
- **[DOC]** "Standard Access is intended for apps that will only be used by people who have roles on them, or used during app development…" (access levels)
- **[DOC]** "If your app will only be used by app users who have a role on the app itself you do not need to complete verification; these users can grant your app any permissions at any time and all features are always active." (business verification)

**But** the people whose messages Dezon must receive and answer are customers. Customers are not app users, and the Messenger docs tie access to whether **the person messaging** has a role:

- **[DOC]** Webhooks: "Advanced Access to receive notifications from your customers, people who do not have a role on your app. Requires App Review." (Messenger webhooks)
- **[DOC]** Conversations: "Advanced Access is required to access conversations between your business and people who do not have a role on your messaging app, your Instagram Professional account, your Facebook Page, or your business." (Conversations API)
- **[DOC]** Profile: "you need to have Advanced Access for the Business Asset User Profile Access feature." (User Profile API)

Customers cannot be given roles legitimately:

- **[DOC]** "You may only add a person as a Tester to your app if they are your employee or you have an agreement with them which establishes that they are acting on your behalf as a tester of your app."
- **[DOC]** The tester cap is 50, or 500 with a verified business.
- Source: https://developers.facebook.com/documentation/development/build-and-test/app-roles

**[INFERENCE]** Conclusion:

- Giving every staff member and Page admin an app role, or a role in Dezon's business portfolio, removes the need for review **for the staff side only**.
- Receiving and replying to real customers requires Advanced Access for `pages_messaging` and its dependencies, which means Business Verification + App Review. There is no compliant shortcut.
- Adding specific customers as Testers is allowed only for people acting as Dezon's testers. Use it only for internal QA, never as a workaround.
- The Development-mode Conversations API returning non-role customers (seen 2026-11-05) contradicts the docs. It may be closed at any time, and it does not cover webhooks or sending.

---

## 5. Data deletion: instructions URL vs callback

Source: https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback

**[DOC]**

- "Apps that access user data must provide a way for users to request that their data be deleted. In accordance with Meta's Platform Terms, all apps must inform users in their privacy policy how to request deletion of their data. Additionally, apps can implement a data deletion request callback…"
- "The data deletion callback is called whenever an app user removes your app and requests that you delete their data. Your app users can do this by going to their Facebook profile and clicking the **Send Request** button on the **Settings & Privacy** > **Settings** > **Apps and Websites** page."
- The callback "must use the secure HTTPS protocol and must be listed in the **Data Deletion Request URL** field". It must:
  - "Initiate the deletion of any data your app has from Facebook about the user";
  - "Return a JSON response that contains a URL where the user can check the status of their deletion request and an alphanumeric confirmation code": `{ url: '<url>', confirmation_code: '<code>' }`.
- "The signed request contains an app-scoped ID identifying the user making the request." It is verified with HMAC-SHA256 using the app secret.
- "The link and confirmation number must give the user access to a human-readable explanation of the status of their request, including a legitimate justification for any refusal to delete…"
- "Failure to comply with these requirements may result in your callback being removed or your app being disabled."
- FAQ: "Every 21 days, you will receive an alert including the user identifiers you are required to delete (which you can download in your app advanced settings page)."
- Basic Settings: "The User Data Delection URL links to explicit instructions for your app users on how to delete their data from your app. This URL may be the relevant section in the application's Privacy Policy." (https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings)
- Platform Terms §4.b: "how Users may request deletion of that data. The right to request deletion must be available to all Users who can access your App."

**[INFERENCE] Recommendation for Dezon: use the instructions URL. A callback is optional.**

- The callback only fires for **app users**, meaning people who logged in with Facebook Login: Dezon staff. It gives an **app-scoped user ID**, not a customer PSID.
- Customers who only message a Page never authorize the app, so they cannot trigger the callback.
- The useful channel for customers is a **public instructions page**, for example `https://dezon.vn/xoa-du-lieu`. It should:
  - explain what Dezon stores from Messenger: name, avatar, PSID, messages and attachments, staff notes and tags;
  - give the ways to request deletion: an email to a privacy address, a message to the Page saying "XÓA DỮ LIỆU", or a form;
  - say what is needed to identify the person (Page name, Facebook name, approximate date);
  - give the response time;
  - say that deletion removes the contact, messages, media and notes (spec §759 already plans "xuất và xóa dữ liệu một khách theo yêu cầu");
  - list what may be retained and why (for example, legal obligations);
  - note that messages also remain in Meta's own Page inbox, which Dezon cannot delete.
- Optionally implement the callback later for staff Facebook Login data: delete the stored user token and the Page tokens obtained through that user, then return `{url, confirmation_code}`.

---

## 6. Side findings (outside this task, relevant to other docs)

- **[DOC]** Graph API **v27.0 is now released**. The Meta blog lists "Introducing Graph API v27.0 and Marketing API v27.0", dated 4 Nov 2026 (seen on the developers blog page). `docs/research/messenger-platform.md` §1 says v27.0 is not released. Re-check and update the pinned version.
- **[DOC]** Messenger policy: when required by applicable law, an automated chat must disclose that it is automated, and Meta recommends it anyway. Example wording includes "You are interacting with an automated experience". Bots marked "automated" must reply within 30 seconds. Inbox apps with human replies are "Manual Reply" or "Hybrid" (Page Settings → Advanced Messaging). Relevant when AI auto-reply ships. (https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy)
- **[DOC]** "If your app does not use a permission for 90 days, usually due to user inactivity, your app user must regrant your app that permission." (permissions reference) Staff should reconnect Pages if they go unused.

## 7. Open items

1. **[UNVERIFIED]** Whether `public_profile` Advanced Access is one-click or needs a recording for this app. Check in "Xét duyệt ứng dụng → Quyền và tính năng".
2. **[AMBIGUOUS]** Business apps "have no app modes" per the docs, but the dashboard shows a toggle. After approval, flip it and confirm that a non-role customer's message arrives by webhook.
3. **[UNVERIFIED]** Maximum length and format of the screencast. No current official statement was found.
4. **[UNVERIFIED]** The exact Vietnamese labels of the dashboard sections (Verification, Data deletion). Field names were checked in English only.
5. Whether reviewers will accept `pages_read_engagement` for an inbox. Fallback: drop it and rely on webhooks plus the User Profile API.
