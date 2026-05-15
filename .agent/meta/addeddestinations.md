# Supported Destinations Registry

This file tracks all analytics and marketing destinations currently supported by ConsentGuard. Each entry defines how the destination is intercepted on the client and transformed on the server.

---

## [ga4] Google Analytics 4
- **Name**: Google Analytics 4
- **Category**: `analytics`
- **Patterns**: `google-analytics.com`
- **Upstream**: `https://www.google-analytics.com/g/collect`
- **Transformations**:
  - `en`: `strip`
  - `uid`: `hash`
  - `uip`: `strip`

## [mixpanel] Mixpanel
- **Name**: Mixpanel
- **Category**: `analytics`
- **Patterns**: `api.mixpanel.com`
- **Upstream**: `https://api.mixpanel.com/track`
- **Transformations**:
  - `properties.$email`: `hash`
  - `properties.distinct_id`: `hash`
  - `properties.ip`: `strip`

## [segment] Segment
- **Name**: Segment
- **Category**: `analytics` (Default)
- **Patterns**: `segment.io`
- **Status**: Intercepted (Uses default scrubbing)

## [amplitude] Amplitude
- **Name**: Amplitude
- **Category**: `analytics`
- **Patterns**: `amplitude.com`
- **Upstream**: `https://api2.amplitude.com/2/httpapi`
- **Transformations**:
  - `events.*.user_id`: `hash`
  - `events.*.device_id`: `hash`
  - `events.*.ip`: `strip`

## [facebook_pixel] Facebook Pixel
- **Name**: Facebook Pixel
- **Category**: `marketing`
- **Patterns**: `facebook.net`
- **Upstream**: `https://graph.facebook.com/v17.0/<PIXEL_ID>/events`
- **Transformations**:
  - `data.*.user_data.em`: `hash`
  - `data.*.user_data.ph`: `hash`
  - `data.*.user_data.client_ip_address`: `strip`

---

*Last Updated: 2026-05-14*
