import { clsx } from 'clsx';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Agent } from '../hooks/useAgents';

interface Props {
  agents: Agent[];
  selected: string | null;
  onSelect: (agentId: string) => void;
  onReorder?: (orderedIds: string[]) => void;
}

interface StateInfo {
  dot: string;
  label: string;
  labelColor: string;
  cardBorder: string;
  cardBg: string;
  shadow: string;
}

function getStateInfo(state: string): StateInfo | null {
  switch (state) {
    case 'thinking':
      return {
        dot: 'bg-orange-400 animate-pulse',
        label: 'thinking…',
        labelColor: 'text-orange-400',
        cardBorder: 'border-orange-400/30',
        cardBg: 'bg-orange-400/5',
        shadow: 'shadow-orange-400/10',
      };
    case 'streaming':
      return {
        dot: 'bg-theme-green animate-pulse',
        label: 'streaming…',
        labelColor: 'text-theme-green',
        cardBorder: 'border-theme-green/30',
        cardBg: 'bg-theme-green/5',
        shadow: 'shadow-theme-green/10',
      };
    case 'warming':
      return {
        dot: 'bg-orange-400 animate-pulse',
        label: 'warming…',
        labelColor: 'text-orange-400',
        cardBorder: 'border-orange-400/30',
        cardBg: 'bg-orange-400/5',
        shadow: 'shadow-orange-400/10',
      };
    case 'error':
      return {
        dot: 'bg-destructive',
        label: 'error',
        labelColor: 'text-destructive',
        cardBorder: 'border-destructive/30',
        cardBg: 'bg-destructive/5',
        shadow: '',
      };
    default:
      return null;
  }
}

function SortableAgentItem({
  agent,
  isSelected,
  onSelect,
  reorderEnabled,
}: {
  agent: Agent;
  isSelected: boolean;
  onSelect: (id: string) => void;
  reorderEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.identity.id,
    disabled: !reorderEnabled,
  });

  const stateInfo = getStateInfo(agent.state);
  const modelShort = agent.model.split('/').pop() ?? agent.model;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      onClick={() => onSelect(agent.identity.id)}
      {...attributes}
      {...listeners}
      className={clsx(
        'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all duration-150 border touch-none select-none',
        isSelected
          ? stateInfo
            ? [stateInfo.cardBorder, stateInfo.cardBg, 'shadow-sm', stateInfo.shadow]
            : 'border-border bg-secondary/80'
          : 'border-transparent hover:bg-secondary/50 hover:border-border/30',
        isDragging && 'shadow-lg cursor-grabbing',
      )}
    >
      <div className="relative shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-secondary/60">
        <span className="text-lg leading-none">{agent.identity.emoji || '🤖'}</span>
        {stateInfo && (
          <span className={clsx(
            'absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-card shrink-0',
            stateInfo.dot,
          )} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className={clsx(
          'text-[13px] font-semibold truncate leading-tight',
          isSelected ? 'text-foreground' : 'text-foreground/80',
        )}>
          {agent.identity.name}
        </div>
        <div className="text-[10px] font-mono truncate mt-0.5 text-muted-foreground/50">
          {modelShort}
        </div>
        {stateInfo && (
          <div className={clsx('text-[9px] font-mono mt-0.5', stateInfo.labelColor)}>
            {stateInfo.label}
          </div>
        )}
      </div>
    </button>
  );
}

export default function AgentSelector({ agents, selected, onSelect, onReorder }: Props) {
  const reorderEnabled = !!onReorder && agents.length > 1;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !onReorder) return;
    const oldIndex = agents.findIndex(a => a.identity.id === active.id);
    const newIndex = agents.findIndex(a => a.identity.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(agents, oldIndex, newIndex).map(a => a.identity.id);
    onReorder(next);
  };

  const items = agents.map(a => a.identity.id);

  return (
    <div className="w-full md:w-52 bg-card border-r border-border flex flex-col overflow-y-auto shrink-0 h-full">
      <div className="px-3 pt-3 pb-1">
        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
          Agents
        </span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1 px-2 pb-2">
            {agents.map((agent) => (
              <SortableAgentItem
                key={agent.identity.id}
                agent={agent}
                isSelected={selected === agent.identity.id}
                onSelect={onSelect}
                reorderEnabled={reorderEnabled}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
