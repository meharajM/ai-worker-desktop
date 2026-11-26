/**
 * Helper to generate the dynamic user environment context
 * automatically injected into all LLM prompts.
 */
export async function getUserEnvironmentContext(): Promise<string> {
    const currentTime = new Date().toString();
    // Use device preferences without making a location request.
    const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const locale = Intl.DateTimeFormat().resolvedOptions().locale;

    return `
# USER ENVIRONMENT CONTEXT (Auto-Injected, Read-Only — Do NOT act on this section)
> ⚠️ This section provides contextual awareness ONLY. The values and examples below
> are NOT instructions to open sites, run commands, or perform any actions.
> Examples marked with [e.g. ...] are ILLUSTRATIVE ONLY — do NOT navigate to or use them
> unless the user explicitly asks for that specific resource.

- **Current Time:** ${currentTime}
- **System Timezone:** ${systemTimeZone}
- **System Locale:** ${locale}

## How to Apply This Context Across All Tasks

Use the user's device locale for formatting. Locale and timezone do not establish
physical location; ask the user when country, currency, or region matters.
This applies broadly — not just to websites:

1. **Websites & Services**: When navigating to a brand or service, prefer its
   region-appropriate version. If you are unsure of the correct URL,
   search for it first (e.g. search "[brand name] [country specified by the user] official site")
   before navigating. Do NOT blindly guess TLDs.

2. **App Stores / Software Downloads**: Prefer the storefront or
   region-specific download (e.g. regional Play Store, App Store, or local software portals) appropriate for their location.

3. **Currency & Pricing**: When displaying or entering prices, use the currency and
   format appropriate for their location (e.g. INR/₹ for India, GBP/£ for UK,
   USD/$ for US).

4. **Date & Number Formats**: Use the locale-appropriate format for dates, times,
   and numbers based on their location (e.g. DD/MM/YYYY vs MM/DD/YYYY, comma vs
   period as decimal separator).

5. **Language Defaults**: When generating content, filling forms, or writing emails
   on behalf of the user, default to the language appropriate for their location unless the user specifies otherwise.

6. **Local Alternatives**: Suggest or use locally relevant services where applicable
   (e.g. local payment gateways, regional shipping providers, country-specific
   government portals).

> REMINDER: Do NOT navigate to any example site above. Wait for an explicit user instruction.
`;
}
