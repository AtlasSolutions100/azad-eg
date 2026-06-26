import { useEffect, useRef } from "react";
import {
  Switch,
  Route,
  Redirect,
  Link,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  Show,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import NotFound from "@/pages/not-found";
import Layout from "./components/layout";

import Dashboard from "@/pages/dashboard";
import PackageWorkspace from "@/pages/package-workspace";
import Invoices from "@/pages/invoices";
import InvoiceDetail from "@/pages/invoice-detail";
import WorkPlans from "@/pages/work-plans";
import Employees from "@/pages/employees";
import Classifications from "@/pages/classifications";
import Signatures from "@/pages/signatures";
import Reference from "@/pages/reference";
import BillingRules from "@/pages/billing-rules";
import ColumnDefinitions from "@/pages/column-definitions";
import AuditLog from "@/pages/audit-log";

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#CFAF42",
    colorForeground: "#333333",
    colorMutedForeground: "#5F5F5F",
    colorDanger: "#dc2626",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#333333",
    colorNeutral: "#d4d4d4",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl border border-neutral-200",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#333333] font-semibold",
    headerSubtitle: "text-[#5F5F5F]",
    socialButtonsBlockButton: "border border-neutral-300 text-[#333333]",
    socialButtonsBlockButtonText: "text-[#333333] font-medium",
    formFieldLabel: "text-[#333333] font-medium",
    formFieldInput: "bg-white text-[#333333] border-neutral-300",
    formButtonPrimary: "bg-[#CFAF42] hover:bg-[#bd9e36] text-white font-semibold",
    footerActionLink: "text-[#CFAF42] hover:text-[#bd9e36] font-medium",
    footerActionText: "text-[#5F5F5F]",
    dividerText: "text-[#5F5F5F]",
    dividerLine: "bg-neutral-200",
    identityPreviewEditButton: "text-[#CFAF42]",
    formFieldSuccessText: "text-emerald-600",
    alertText: "text-[#333333]",
    logoBox: "justify-center",
    logoImage: "h-10",
    otpCodeFieldInput: "text-[#333333] border-neutral-300",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

function Landing() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 text-center">
      <div className="mb-8">
        <img src={`${basePath}/logo.svg`} alt="Azad Engineering PC" className="h-14" />
      </div>
      <h1 className="mb-3 text-3xl font-semibold tracking-tight text-[#333333]">
        Invoice Automation
      </h1>
      <p className="mb-8 max-w-md text-[#5F5F5F]">
        Internal billing workspace for Azad Engineering PC. Sign in to manage
        work plans, generate invoices, and export BART progress billings.
      </p>
      <Link href="/sign-in">
        <Button className="bg-[#CFAF42] px-8 text-white hover:bg-[#bd9e36]">
          Sign In
        </Button>
      </Link>
    </div>
  );
}

function AppShell() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/packages/:id" component={PackageWorkspace} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/invoices/:id" component={InvoiceDetail} />
        <Route path="/work-plans" component={WorkPlans} />
        <Route path="/employees" component={Employees} />
        <Route path="/classifications" component={Classifications} />
        <Route path="/signatures" component={Signatures} />
        <Route path="/reference" component={Reference} />
        <Route path="/billing-rules" component={BillingRules} />
        <Route path="/column-definitions" component={ColumnDefinitions} />
        <Route path="/audit-log" component={AuditLog} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route>
        <Show when="signed-in">
          <AppShell />
        </Show>
        <Show when="signed-out">
          <Switch>
            <Route path="/" component={Landing} />
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        </Show>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to the Azad billing workspace",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Request access to the Azad billing workspace",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
