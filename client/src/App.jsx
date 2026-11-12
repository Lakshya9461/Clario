import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import LoginView from "./views/LoginView.jsx";
import RegisterView from "./views/RegisterView.jsx";
import TopicsView from "./views/TopicsView.jsx";
import SessionsView from "./views/SessionsView.jsx";
import LearnView from "./views/LearnView.jsx";
import AdminPacksView from "./views/AdminPacksView.jsx";
import AdminUsersView from "./views/AdminUsersView.jsx";
import AnalyticsView from "./views/AnalyticsView.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import AdminRoute from "./components/AdminRoute.jsx";
import NotFoundView from "./views/NotFoundView.jsx";

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <Outlet />
    </ProtectedRoute>
  );
}

function AdminLayout() {
  return (
    <AdminRoute>
      <Outlet />
    </AdminRoute>
  );
}

const router = createBrowserRouter([
  // Public routes — no layout, no auth required.
  { path: "/login", element: <LoginView /> },
  { path: "/register", element: <RegisterView /> },

  // Protected routes — wrapped in Layout + ProtectedRoute.
  {
    path: "/",
    element: (
      <Layout>
        <ProtectedLayout>
          <Outlet />
        </ProtectedLayout>
      </Layout>
    ),
    children: [
      { index: true, element: <Navigate to="/topics" replace /> },
      { path: "topics", element: <TopicsView /> },
      { path: "sessions", element: <SessionsView /> },
      { path: "learn/:sessionId", element: <LearnView /> },
      {
        path: "admin",
        element: <AdminLayout />,
        children: [
          { path: "packs", element: <AdminPacksView /> },
          { path: "users", element: <AdminUsersView /> },
          { path: "analytics", element: <AnalyticsView /> },
        ],
      },
    ],
  },

  // Catch-all 404.
  { path: "*", element: <NotFoundView /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
