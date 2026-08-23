# Installing the interceptor

The proxy can only scrub a request it receives. Everything below is about making
sure the request arrives.

## The Sluice tag goes first

Put the Sluice bundle at the top of `<head>`, above every other script, tag
manager, and pixel:

```html
<head>
  <script src="/sluice.js"></script>
  <!-- everything else -->
</head>
```

This is a requirement, not a recommendation, and it is not something the client
can work around. Two failure modes follow directly from load order:

- **A tracker that captured `window.fetch` before the bundle ran keeps the
  unpatched reference.** Patching a global only affects code that reads it
  afterwards. A snippet above the Sluice tag that stashes `const f =
window.fetch` on load will use `f` forever, and the firewall never sees those
  requests.
- **An `<img>` written into the initial HTML above the Sluice tag has its `src`
  set by the parser**, which does not go through the property setter the
  interceptor patches. The request is issued before the bundle exists.

Below the tag, both are covered: the patched primitives catch anything script
builds, and a mutation observer catches pixels and tracker scripts the parser
appends as it goes.

There is deliberately no document-ready sweep behind the observer. By the time
the document is ready, every parser-issued request has already gone out — a
sweep could not prevent the leak, and rewriting those elements then would send
the vendor the same event a second time.

### Checking it

Nothing in the page reports this, so check it the way an auditor would: load the
site with devtools open, filter the network panel by a vendor domain, and
confirm nothing goes there directly. A request to `facebook.com/tr` or
`google-analytics.com/g/collect` that is not addressed to your proxy path is a
tracker Sluice never saw.

## Configuration

The bundle reads its configuration from a meta tag or from `window.__sluiceConfig`:

```html
<meta name="sluice-config" content='{"proxyPath":"/analytics"}' />
```

| Option                    | Default      | Meaning                                                                    |
| ------------------------- | ------------ | -------------------------------------------------------------------------- |
| `proxyUrl`                | —            | Absolute proxy URL. Overrides `proxyPath`.                                 |
| `proxyPath`               | `/analytics` | Path where the proxy is mounted on the app's own origin.                   |
| `destinations`            | built-in     | Extra `host[/pathPrefix]` → destination id entries, merged with the table. |
| `domains`                 | —            | Extra hosts to treat as tracking, proxied under destination `unknown`.     |
| `userId`                  | —            | Pin the identifier instead of using the per-session one.                   |
| `observeMutations`        | `true`       | Watch the DOM for injected tracker scripts and parser-inserted pixels.     |
| `dangerouslyAllowOnError` | `false`      | Send directly to the vendor if the proxy is unreachable. Leave it off.     |

A pattern matches a host and its subdomains, with an optional path prefix that
has to match whole segments: `facebook.com/tr` covers `www.facebook.com/tr` but
not `www.facebook.com/track`, and `amplitude.com` covers `api2.amplitude.com`
but not `notamplitude.com`.

## What a destination costs

Interception is only half of it — the proxy has to be able to serve the vendor
it intercepted. `sluice status` prints the support level per destination:

| Level         | What happens to the traffic                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `adapter`     | Translated into the vendor's server-side API and forwarded.                                                   |
| `passthrough` | Scrubbed and forwarded to the endpoint the browser targeted.                                                  |
| `unsupported` | Refused at `/ingest` and audited. The payload is encoded, so it cannot be scrubbed — and it is not forwarded. |

An `unsupported` destination still gets intercepted, which is the point: the
vendor receives nothing rather than receiving it unscrubbed.
