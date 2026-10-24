/** The skeleton shown in place of a page while it loads (RouteSkeleton): a data strip, four figures and a block. */
export function PageLoading() {
  return (
    <div className="pageloading" role="status" aria-live="polite">
      <span className="sr">Loading…</span>
      <div className="skel skelstrip" />
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card skelcard">
            <div className="skel skelchip" />
            <div className="skellines">
              <div className="skel skelline short" />
              <div className="skel skelline big" />
            </div>
          </div>
        ))}
      </div>
      <div className="skel skelhead" />
      <div className="card skelblock">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel skelline" />
        ))}
      </div>
    </div>
  )
}
