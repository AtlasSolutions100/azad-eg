import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { FileText, LayoutDashboard, Briefcase, Users, FileSignature, Settings, FileSearch, Search } from "lucide-react";
import logoUrl from "@assets/Azad_Logo_1782418426096.jpeg";
import { useSearch } from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

export default function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [open, setOpen] = useState(false);
  
  const { data: searchResults } = useSearch(
    { q: searchQuery },
    { query: { enabled: searchQuery.length > 2, queryKey: ["search", searchQuery] } },
  );

  const navItems = [
    { label: "Dashboard", href: "/", icon: LayoutDashboard },
    { label: "Invoices", href: "/invoices", icon: FileText },
    { label: "Work Plans", href: "/work-plans", icon: Briefcase },
    { label: "Employees", href: "/employees", icon: Users },
    { label: "Signatures", href: "/signatures", icon: FileSignature },
    { label: "Reference Data", href: "/reference", icon: Settings },
    { label: "Column Definitions", href: "/column-definitions", icon: Settings },
    { label: "Audit Log", href: "/audit-log", icon: FileSearch },
  ];

  return (
    <div className="flex h-screen bg-gray-50 text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-border flex flex-col flex-shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <img src={logoUrl} alt="Azad Engineering" className="h-8 object-contain" />
        </div>
        <nav className="flex-1 py-4 overflow-y-auto px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href} 
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-primary/10 text-primary" 
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-border flex items-center px-8 justify-between flex-shrink-0 shadow-sm">
          <div className="flex items-center text-sm font-medium text-gray-500">
            Azad Invoice Automation
          </div>
          <div className="flex items-center gap-4">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <div className="relative cursor-pointer">
                  <input 
                    type="text" 
                    placeholder="Global Search..." 
                    className="pl-8 pr-4 py-1.5 bg-gray-100 border-transparent rounded-md text-sm focus:ring-2 focus:ring-primary/20 outline-none w-64 cursor-pointer pointer-events-none" 
                    readOnly
                  />
                  <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-[300px] p-0" align="end">
                <Command>
                  <CommandInput placeholder="Search client, employee, job..." value={searchQuery} onValueChange={setSearchQuery} />
                  <CommandList>
                    <CommandEmpty>{searchQuery.length > 2 ? "No results found." : "Type at least 3 characters to search."}</CommandEmpty>
                    {searchResults && searchResults.length > 0 && (
                      <CommandGroup heading="Results">
                        {searchResults.map((result, i) => (
                          <CommandItem 
                            key={i} 
                            value={`${result.type}-${result.id}-${result.label}`}
                            onSelect={() => {
                              setLocation(result.route);
                              setOpen(false);
                            }}
                          >
                            <div className="flex flex-col">
                              <span className="font-medium">{result.label}</span>
                              {result.sublabel && <span className="text-xs text-muted-foreground">{result.sublabel}</span>}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs">
              AE
            </div>
          </div>
        </header>
        
        {/* Content */}
        <div className="flex-1 overflow-auto bg-gray-50 p-6">
          {children}
        </div>
      </main>
    </div>
  );
}