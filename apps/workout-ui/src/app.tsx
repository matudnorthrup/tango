import { Routes, Route } from 'react-router-dom';
import { useLiveRefresh } from './lib/live';
import { Layout } from './components/layout';
import { LivePage } from './pages/live';
import { WorkoutDetailPage } from './pages/workout-detail';
import { RoutinesPage } from './pages/routines';
import { RoutineDetailPage } from './pages/routine-detail';
import { CalendarPage } from './pages/calendar';
import { ExercisesPage } from './pages/exercises';
import { ExerciseDetailPage } from './pages/exercise-detail';
import { StatsPage } from './pages/stats';

export function App() {
  useLiveRefresh();
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<LivePage />} />
        <Route path="/workouts/:id" element={<WorkoutDetailPage />} />
        <Route path="/routines" element={<RoutinesPage />} />
        <Route path="/routines/new" element={<RoutineDetailPage isNew />} />
        <Route path="/routines/:id" element={<RoutineDetailPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/exercises" element={<ExercisesPage />} />
        <Route path="/exercises/:id" element={<ExerciseDetailPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="*" element={<LivePage />} />
      </Routes>
    </Layout>
  );
}
