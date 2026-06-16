export default function Spinner({ text = 'Chargement…' }: { text?: string }) {
  return <p className="loading-text">{text}</p>
}
