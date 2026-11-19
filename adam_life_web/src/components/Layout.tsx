import { ArrowLeft, ArrowRight, BellRing, ChartNoAxesCombined, CircleHelp, LayoutDashboard, ListFilter, Plus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { View } from '../domain/finance'

export const navigation: { id: View; title: string; icon: LucideIcon }[] = [
  { id: 'overview', title: 'Главная', icon: LayoutDashboard },
  { id: 'transactions', title: 'Операции', icon: ListFilter },
  { id: 'analytics', title: 'Аналитика', icon: ChartNoAxesCombined },
  { id: 'payments', title: 'Платежи', icon: BellRing },
]
export function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M5 19 12 5l7 14M8.5 12h7" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>Adam<span className="brand-soft">Life</span></span></div>
}
export function Layout({ view, onNavigate, onAdd, onInfo, children, accountControl, historyNavigation }: { historyNavigation?: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void }; view: View; onNavigate: (view: View) => void; onAdd?: () => void; onInfo?: () => void; children: ReactNode; accountControl?: ReactNode }) {
  return <div className="app-shell">
    <a className="skip-link" href="#main">Перейти к содержимому</a>
    <aside className="sidebar">
      <button className="brand-button" onClick={() => onNavigate('overview')} aria-label="AdamLife — главная"><Brand /></button>
      <div className="nav-label">МОИ ФИНАНСЫ</div>
      <nav aria-label="Основная навигация" className="desktop-nav">{navigation.map(({ id, title, icon: Icon }) => <button key={id} className={`nav-item ${id === view ? 'active' : ''}`} aria-current={id === view ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={20} strokeWidth={1.7} /><span>{title}</span>{id === view && <span className="active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><span className="local-label">{accountControl ? 'Ваш аккаунт' : 'На этом устройстве'}</span><p>Личное пространство</p></div>
    </aside>
    <div className="main-area"><div className="topbar"><span className="desktop-breadcrumb">Личное пространство / <span>{navigation.find(item => item.id === view)?.title}</span></span><div className="mobile-brand"><Brand small /></div>{historyNavigation && <div className="history-navigation" role="group" aria-label="История переходов"><button className="icon-button" aria-label="Назад" title="Назад" disabled={!historyNavigation.canBack} onClick={historyNavigation.back}><ArrowLeft size={18} /></button><button className="icon-button" aria-label="Вперёд" title="Вперёд" disabled={!historyNavigation.canForward} onClick={historyNavigation.forward}><ArrowRight size={18} /></button></div>}{accountControl ?? <button className="test-indicator" onClick={onInfo}>Тестовые данные <CircleHelp size={14} /></button>}</div><main id="main" tabIndex={-1}>{children}</main></div>
    {onAdd && <div className="mobile-add-dock"><button className="floating-add" aria-label="Быстро добавить операцию" onClick={onAdd}><Plus size={25} /></button></div>}
    <nav className="mobile-nav" aria-label="Нижняя навигация">{navigation.map(({ id, title, icon: Icon }) => <button key={id} className={id === view ? 'active' : ''} aria-current={id === view ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={21} strokeWidth={1.7} /><span>{title}</span></button>)}</nav>
  </div>
}
