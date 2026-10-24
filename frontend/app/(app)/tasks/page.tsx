import { SectionHead } from '@/components/section-head'
import { TaskBoard } from './task-board'

export default function TasksPage() {
  return (
    <section className="sec">
      <SectionHead
        title="Task board"
        sub="Add work, give it a category, and assign it. Drag a card to move it."
        zid="Zone 1 · Tasks"
      />
      <TaskBoard />
    </section>
  )
}
