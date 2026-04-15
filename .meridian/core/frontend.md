# Core Frontend Standards

## Inherited Standards
@./global.md

## 🎨 Frontend Principles
1. **Component-Driven Design:** Build isolated, reusable components (Atomic Design).
2. **State Management:** Keep state as local as possible. Only lift state or use Global State (Redux/Zustand) when strictly necessary.
3. **Accessibility (A11y):** Use semantic HTML and ARIA labels. Ensure the application is keyboard-navigable.
4. **Performance:** 
    - Optimize images and assets.
    - Use Lazy Loading for routes and heavy components.
5. **Responsive Design:** Follow a "Mobile-First" approach. Use modern CSS (Flexbox/Grid).
6. **Error Boundaries:** Gracefully handle frontend crashes without breaking the entire UI.
