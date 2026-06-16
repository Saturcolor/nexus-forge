import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { MessageSquare, Users, Bot, Plug, Bell, Settings, ScrollText, Brain, CalendarClock, Swords, Menu, X, FlaskConical } from 'lucide-react';
import { clsx } from 'clsx';
import ErrorBoundary from './ErrorBoundary';
import StatusBar from './StatusBar';
import ProactiveToast from './ProactiveToast';
import { useProactiveAlerts } from '../lib/proactiveAlerts';
import useIsMobile from '../hooks/useIsMobile';
import { wsClient } from '../lib/ws';

const navItems = [
  { to: '/', icon: MessageSquare, label: 'Chat', badgeKey: null as null | 'proactive' },
  { to: '/agents', icon: Users, label: 'Agents', badgeKey: null },
  { to: '/sub-agents', icon: Bot, label: 'Sub-agents', badgeKey: null },
  { to: '/providers', icon: Plug, label: 'Providers', badgeKey: null },
  { to: '/telegram', icon: Bell, label: 'Delivery', badgeKey: null },
  { to: '/scheduler', icon: CalendarClock, label: 'Taches', badgeKey: 'proactive' as const },
  { to: '/war-room', icon: Swords, label: 'War Room', badgeKey: null },
  { to: '/settings', icon: Settings, label: 'Settings', badgeKey: null },
  { to: '/memory', icon: Brain, label: 'Mémoire', badgeKey: null },
  { to: '/logs', icon: ScrollText, label: 'Logs', badgeKey: null },
  { to: '/advanced', icon: FlaskConical, label: 'Advanced', badgeKey: null },
];

export default function Layout() {
  const { unreadCount } = useProactiveAlerts();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false);
  }, [isMobile]);

  // Hold the app-wide WebSocket open for the whole session. The socket is a ref-counted
  // singleton; Layout wraps every route via <Outlet/> and stays mounted for the entire
  // session, so connecting here keeps live updates (StatusBar, proactive alerts, agent
  // state, War Room...) alive on EVERY page — not just Chat. Page-level consumers (ChatPage)
  // add their own ref on top and release it on unmount without tearing down the shared socket.
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.release();
  }, []);

  const currentLabel = navItems.find(
    item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
  )?.label ?? 'Mastermind';

  const navContent = (
    <>
      <div className="text-xl font-bold text-foreground mb-4 flex items-center justify-center">M</div>
      {navItems.map(({ to, icon: Icon, label, badgeKey }) => {
        const badgeCount = badgeKey === 'proactive' ? unreadCount : 0;
        return (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'relative flex items-center gap-3 rounded-lg transition-colors',
                isMobile ? 'px-4 py-3' : 'w-10 h-10 justify-center',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
              )
            }
            title={label}
          >
            <Icon size={20} />
            {isMobile && <span className="text-sm font-medium">{label}</span>}
            {badgeCount > 0 && (
              <span className={clsx(
                'min-w-[16px] h-[16px] px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center',
                isMobile ? 'ml-auto' : 'absolute -top-0.5 -right-0.5',
              )}>
                {badgeCount > 9 ? '9+' : badgeCount}
              </span>
            )}
          </NavLink>
        );
      })}
    </>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Mobile header */}
      {isMobile && (
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(o => !o)}
            className="p-2 -ml-1 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="text-sm font-semibold text-foreground">{currentLabel}</span>
          <div className="w-9" />
        </header>
      )}

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar */}
        {!isMobile && (
          <nav className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2 shrink-0">
            {navContent}
          </nav>
        )}

        {/* Mobile sidebar overlay */}
        {isMobile && mobileMenuOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
            <nav className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col py-4 gap-1 overflow-y-auto animate-[slide-in-left_200ms_ease-out]">
              {navContent}
            </nav>
          </>
        )}

        {/* Page content */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* Global status bar */}
      <StatusBar />
      <ProactiveToast />
    </div>
  );
}
