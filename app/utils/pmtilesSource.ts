import type { RangeResponse, Source } from 'pmtiles'

// PMTiles archives are addressed by HTTP Range — pmtiles' built-in
// FetchSource throws "no content-length / content-length exceeding request"
// when the server returns 200 with the whole archive instead of 206. That
// can happen on Cloudflare in front of GitHub Pages: `.pmtiles` isn't in
// CF's default cacheable-extension list, so cf-cache-status goes DYNAMIC
// and the proxied response loses Content-Length. This Source detects the
// dropped Range and falls back to a one-time whole-file download (cached
// in memory, sliced per getBytes), with a one-time console.warn so the
// misconfig stays visible instead of silently costing ~18 MB per cold
// visitor. The proper fix is still a CDN Cache Rule for `.pmtiles`.
export class RangeOrWholeSource implements Source {
  private whole: Promise<ArrayBuffer> | null = null

  constructor(public url: string) {}

  getKey(): string {
    return this.url
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    // Read `whole` into a local at each check so TS' control-flow analysis
    // doesn't narrow it to `never` after we've ruled out non-null — it can't
    // model concurrent async mutation of the field.
    const cachedBefore = this.whole
    if (cachedBefore) {
      const buf = await cachedBefore
      return { data: buf.slice(offset, offset + length) }
    }

    const headers = new Headers({ range: `bytes=${offset}-${offset + length - 1}` })
    const resp = await fetch(this.url, { signal, headers })
    if (resp.status >= 300) throw new Error(`Bad response code: ${resp.status}`)

    const contentLengthHeader = resp.headers.get('Content-Length')
    const contentLength = contentLengthHeader != null ? +contentLengthHeader : NaN

    // Range honoured: explicit 206, or a 200 whose body fits the request
    // (legitimate when the whole archive is smaller than the probe).
    if (resp.status === 206 || (resp.status === 200 && contentLength > 0 && contentLength <= length)) {
      const etagHeader = resp.headers.get('Etag')
      // Weak ETags can't gate If-Match retries reliably; pmtiles' built-in
      // FetchSource treats them as no-etag, so mirror that behaviour.
      const etag = etagHeader && !etagHeader.startsWith('W/') ? etagHeader : undefined
      return {
        data: await resp.arrayBuffer(),
        etag,
        cacheControl: resp.headers.get('Cache-Control') || undefined,
        expires: resp.headers.get('Expires') || undefined
      }
    }

    // Fallback: server ignored Range. Re-check after the await — a concurrent
    // caller may have raced ahead and already started the whole-file read; if
    // so, adopt theirs and drop our duplicate response without allocating its
    // ~18 MB body into the JS heap. The first caller to land here is also the
    // one that emits the warn.
    const cachedAfter = this.whole
    if (cachedAfter) {
      const buf = await cachedAfter
      return { data: buf.slice(offset, offset + length) }
    }
    console.warn(
      `[pmtiles] ${this.url}: server returned ${resp.status} for a Range request `
      + `(${contentLengthHeader ?? 'no content-length'}). The host isn't serving HTTP byte `
      + `ranges — falling back to a one-time whole-file download. To restore tile-by-tile `
      + `fetches, configure the CDN to serve 206 for .pmtiles (e.g. a Cloudflare Cache Rule).`
    )
    // The open response IS the whole archive (Range was ignored) — reuse its
    // body instead of issuing a second fetch. The identity check in the
    // rejection handler ensures a stale catch from a failed earlier attempt
    // can't null out a fresh promise assigned by a subsequent retry.
    const p = resp.arrayBuffer()
    this.whole = p
    p.catch(() => {
      if (this.whole === p) this.whole = null
    })
    const buf = await p
    return { data: buf.slice(offset, offset + length) }
  }
}
