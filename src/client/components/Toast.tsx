type Props = {
  message: string | null
}

export function Toast({ message }: Props) {
  return (
    <div className={`toast${message ? ' is-visible' : ''}`} role="status">
      {message ?? ''}
    </div>
  )
}
