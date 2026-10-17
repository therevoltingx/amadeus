import { useState, useEffect } from 'react'
import { PairsTab } from './components/PairsTab'
import { SnapshotsTab } from './components/SnapshotsTab'
import { TradesTab } from './components/TradesTab'
import { TradeDecisionsTab } from './components/TradeDecisionsTab'
import { PoliciesTab } from './components/PoliciesTab'
import { PairScoresTab } from './components/PairScoresTab'
import { AccountTab } from './components/AccountTab'
import { DeploymentsTab } from './components/DeploymentsTab'
import { StatsTab } from './components/StatsTab'
import { AnalyticsTab } from './components/AnalyticsTab'
import { RecommendationsTab } from './components/RecommendationsTab'
import { BacktestsTab } from './components/BacktestsTab'
import { AgentTab } from './components/AgentTab'
import './App.css'

type Tab = 'pairs' | 'snapshots' | 'scores' | 'trades' | 'decisions' | 'policies' | 'deployments' | 'backtests' | 'analytics' | 'leaderboard' | 'recommendations' | 'agent' | 'account';

const TAB_STORAGE_KEY = 'amadeus-active-tab';

function getStoredTab(): Tab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    if (stored === 'pairs' || stored === 'snapshots' || stored === 'scores' || stored === 'trades' || stored === 'decisions' || stored === 'policies' || stored === 'deployments' || stored === 'backtests' || stored === 'analytics' || stored === 'leaderboard' || stored === 'recommendations' || stored === 'agent' || stored === 'account') return stored;
  } catch {}
  return 'pairs';
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>(getStoredTab);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, activeTab);
    } catch {}
  }, [activeTab]);

  return (
    <div className="app">
      <nav className="app-nav">
        <div className="app-brand">
          <img src="/logo.svg" alt="" className="app-logo" />
        </div>
        <div className="app-tabs">
          <button
            className={`tab ${activeTab === 'pairs' ? 'active' : ''}`}
            onClick={() => setActiveTab('pairs')}
          >
            Pairs
          </button>
          <button
            className={`tab ${activeTab === 'snapshots' ? 'active' : ''}`}
            onClick={() => setActiveTab('snapshots')}
          >
            Snapshots
          </button>
          <button
            className={`tab ${activeTab === 'scores' ? 'active' : ''}`}
            onClick={() => setActiveTab('scores')}
          >
            Scores
          </button>
          <button
            className={`tab ${activeTab === 'decisions' ? 'active' : ''}`}
            onClick={() => setActiveTab('decisions')}
          >
            Decisions
          </button>
          <button
            className={`tab ${activeTab === 'trades' ? 'active' : ''}`}
            onClick={() => setActiveTab('trades')}
          >
            Trades
          </button>
          <button
            className={`tab ${activeTab === 'policies' ? 'active' : ''}`}
            onClick={() => setActiveTab('policies')}
          >
            Policies
          </button>
          <button
            className={`tab ${activeTab === 'deployments' ? 'active' : ''}`}
            onClick={() => setActiveTab('deployments')}
          >
            Deployments
          </button>
          <button
            className={`tab ${activeTab === 'recommendations' ? 'active' : ''}`}
            onClick={() => setActiveTab('recommendations')}
          >
            Recommendations
          </button>
          <button
            className={`tab ${activeTab === 'backtests' ? 'active' : ''}`}
            onClick={() => setActiveTab('backtests')}
          >
            Backtests
          </button>
          <button
            className={`tab ${activeTab === 'leaderboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('leaderboard')}
          >
            Leaderboard
          </button>
          <button
            className={`tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </button>
          <button
            className={`tab ${activeTab === 'agent' ? 'active' : ''}`}
            onClick={() => setActiveTab('agent')}
          >
            Chatbot
          </button>
          <button
            className={`tab ${activeTab === 'account' ? 'active' : ''}`}
            onClick={() => setActiveTab('account')}
          >
            Account
          </button>
        </div>
      </nav>
      <main className="app-main">
        {activeTab === 'pairs' && <PairsTab />}
        {activeTab === 'snapshots' && <SnapshotsTab />}
        {activeTab === 'scores' && <PairScoresTab />}
        {activeTab === 'trades' && <TradesTab />}
        {activeTab === 'decisions' && <TradeDecisionsTab />}
        {activeTab === 'policies' && <PoliciesTab />}
        {activeTab === 'deployments' && <DeploymentsTab />}
        {activeTab === 'backtests' && <BacktestsTab />}
        {activeTab === 'analytics' && <AnalyticsTab />}
        {activeTab === 'leaderboard' && <StatsTab />}
        {activeTab === 'recommendations' && <RecommendationsTab />}
        {activeTab === 'agent' && <AgentTab />}
        {activeTab === 'account' && <AccountTab />}
      </main>
    </div>
  )
}

export default App
