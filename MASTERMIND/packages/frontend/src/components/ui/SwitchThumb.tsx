export function SwitchThumb({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      className={`relative shrink-0 inline-block w-[30px] h-[18px] rounded-full transition-colors ${
        on ? 'bg-theme-green' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] ${
          on ? 'left-[14px]' : 'left-[2px]'
        }`}
      />
    </span>
  );
}
