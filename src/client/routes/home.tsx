import { useNavigate } from '@tanstack/react-router'
import { uid } from '../ui'

export function HomePage() {
  const navigate = useNavigate()

  const create = () => {
    void navigate({ to: '/n/$roomId', params: { roomId: uid(6) } })
  }

  return (
    <main className="home">
      <div className="home-inner">
        <p className="home-brand">live-sync</p>

        <h1 className="home-title">A notepad you share with a link.</h1>
        <p className="home-lede">
          No accounts. Type together in real time, keep separate tabs, and drop
          files in. Everyone holding the link sees the same thing.
        </p>

        <button type="button" className="btn-primary home-cta" onClick={create}>
          Create a notepad
        </button>

        <ol className="home-steps">
          <li>
            <strong>Write or paste</strong> anything. It saves itself.
          </li>
          <li>
            <strong>Send the link.</strong> Edits appear live for everyone.
          </li>
          <li>
            <strong>Drop files</strong> to attach them to the notepad.
          </li>
        </ol>

        <p className="home-foot">Already have a link? Just open it.</p>
      </div>
    </main>
  )
}
