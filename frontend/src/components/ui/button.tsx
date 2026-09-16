import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
const buttonVariants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer', { variants: { variant: { default: 'bg-[#214e3e] text-white hover:bg-[#173b2e] shadow-sm', outline: 'border border-[#dfe5df] bg-white text-[#33443b] hover:bg-[#f2f5f1]', ghost: 'text-[#66756c] hover:bg-[#edf1ec]', destructive: 'bg-red-50 text-red-700 hover:bg-red-100' }, size: { default: 'h-10 px-4 py-2', sm: 'h-9 px-3 text-xs', lg: 'h-12 px-6', icon: 'h-9 w-9' } }, defaultVariants: { variant: 'default', size: 'default' } });
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => { const Comp = asChild ? Slot : 'button'; return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />; });
Button.displayName = 'Button';
export { buttonVariants };
