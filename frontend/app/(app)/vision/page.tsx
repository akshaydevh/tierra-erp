import { SectionHead } from '@/components/section-head'
import { api } from '@/lib/api'
import type { VisionStatus } from '@/lib/types'
import { HairnetDemo } from './hairnet-demo'

export default async function VisionPage() {
  const status = await api<VisionStatus>('/api/vision')
  return (
    <>
      <section className="sec">
        <SectionHead
          title="Hairnet check"
          sub="A computer-vision demo on this computer's webcam. Tierra looks at one frame and says whether the person in it is wearing a hairnet."
          actions={<span className="pill amber">Demo</span>}
        />
        <HairnetDemo configured={status.configured} model={status.model} />
      </section>
      <section className="sec">
        <SectionHead title="Where this goes" />
        <div className="cvroad">
          <div className="card p6">
            <span className="pill ok">Now</span>
            <h4>Webcam demo</h4>
            <p className="note">
              One person in front of a laptop camera. Check a single frame, or turn on live to check every few seconds.
            </p>
          </div>
          <div className="card p6">
            <span className="pill grey">Next</span>
            <h4>Factory-floor cameras</h4>
            <p className="note">
              The same check on the floor cameras, so a person working without a hairnet is flagged during the shift.
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
