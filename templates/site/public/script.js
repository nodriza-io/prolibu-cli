/* eslint-env browser */

// Welcome message
console.log('🚀 Prolibu Site loaded successfully!');

// Get API configuration
function getApiConfig() {
    // Check if we have the auto-generated config (dev mode)
    if (window.__PROLIBU_CONFIG__) {
        return window.__PROLIBU_CONFIG__;
    }
    
    // Production mode - use current domain
    const domain = window.location.hostname;
    return {
        domain: domain,
        apiBaseUrl: `https://${domain}/v2`,
        isDev: false
    };
}

// Utility function for API calls
async function fetchAPI(endpoint, options = {}) {
    try {
        const apiKey = localStorage.getItem('apiKey');
        const config = getApiConfig();
        
        const response = await fetch(`${config.apiBaseUrl}/${endpoint}`, {
            ...options,
            headers: {
                'Authorization': apiKey ? `Bearer ${apiKey}` : '',
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// Check if domain is a Prolibu domain
function isProlibaDomain() {
    const hostname = window.location.hostname;
    return hostname.endsWith('.prolibu.com');
}

// Redirect to Prolibu auth
function redirectToAuth() {
    const domain = window.location.hostname;
    const siteUrl = encodeURIComponent(window.location.href);
    window.location.href = `https://${domain}/v2/auth/signin?redirect=${siteUrl}`;
}

// Clear authentication and show login
function clearAuthAndShowLogin() {
    localStorage.removeItem('apiKey');
    localStorage.removeItem('me');
    
    // Remove user info from header if exists
    const headerContent = document.querySelector('.header-content');
    if (headerContent) {
        const userInfo = headerContent.querySelector('div:last-child');
        if (userInfo && userInfo.innerHTML.includes('Logout')) {
            userInfo.remove();
        }
    }
    
    if (isProlibaDomain()) {
        redirectToAuth();
    } else {
        showLoginForm();
    }
}

// Validate user authentication
async function validateAuth() {
    const apiKey = localStorage.getItem('apiKey');
    
    // No apiKey, show login
    if (!apiKey) {
        clearAuthAndShowLogin();
        return false;
    }
    
    // Validate apiKey with /v2/user/me
    try {
        const config = getApiConfig();
        const response = await fetch(`${config.apiBaseUrl}/user/me`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.status !== 200) {
            // Invalid apiKey, clear and show login
            clearAuthAndShowLogin();
            return false;
        }
        
        const user = await response.json();
        localStorage.setItem('me', JSON.stringify(user));
        return true;
    } catch (error) {
        console.error('Auth validation failed:', error);
        clearAuthAndShowLogin();
        return false;
    }
}

// Show login form
function showLoginForm() {
    const main = document.querySelector('.main');
    if (!main) return;
    
    main.innerHTML = `
        <div class="container">
            <div class="card" style="max-width: 500px; margin: 100px auto;">
                <h2 style="margin-bottom: 30px;">Signin</h2>
                
                <form id="loginForm" style="display: flex; flex-direction: column; gap: 15px;">
                    <div>
                        <label for="email" style="display: block; margin-bottom: 5px; font-weight: 500;">Email</label>
                        <input 
                            type="email" 
                            id="email" 
                            name="email" 
                            placeholder="jdoe@acme.com"
                            required
                            style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;"
                        >
                    </div>
                    
                    <div>
                        <label for="password" style="display: block; margin-bottom: 5px; font-weight: 500;">Password</label>
                        <input 
                            type="password" 
                            id="password" 
                            name="password" 
                            placeholder="Enter your password"
                            required
                            style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;"
                        >
                    </div>
                    
                    <button 
                        type="submit" 
                        style="padding: 12px; background: #000; color: white; border: none; border-radius: 4px; font-weight: 500; cursor: pointer; font-size: 14px;"
                    >
                        Login
                    </button>
                    
                    <div id="loginError" style="display: none; color: #e91e63; text-align: center; font-size: 14px;"></div>
                </form>
            </div>
        </div>
    `;
    
    // Handle login form submission
    const form = document.getElementById('loginForm');
    const errorDiv = document.getElementById('loginError');
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        if (!email || !password) {
            errorDiv.textContent = 'Please enter both email and password';
            errorDiv.style.display = 'block';
            return;
        }
        
        // Call /v2/auth/signin
        try {
            const config = getApiConfig();
            const response = await fetch(`${config.apiBaseUrl}/auth/signin`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });
            
            if (response.status !== 200) {
                const error = await response.json().catch(() => ({}));
                errorDiv.textContent = error.error || error.message || 'Invalid email or password';
                errorDiv.style.display = 'block';
                return;
            }
            
            const data = await response.json();
            
            if (!data.apiKey) {
                errorDiv.textContent = 'Login failed. No API key received.';
                errorDiv.style.display = 'block';
                return;
            }
            
            // Store apiKey (without Bearer prefix)
            localStorage.setItem('apiKey', data.apiKey);
            
            // Now get user info
            const userResponse = await fetch(`${config.apiBaseUrl}/user/me`, {
                headers: {
                    'Authorization': `Bearer ${data.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (userResponse.status === 200) {
                const user = await userResponse.json();
                localStorage.setItem('me', JSON.stringify(user));
            }
            
            // Reload to show main content
            window.location.reload();
        } catch (error) {
            console.error('Login error:', error);
            errorDiv.textContent = 'Login failed. Please check your connection.';
            errorDiv.style.display = 'block';
        }
    });
}

// Show main content
function showMainContent() {
    console.log('✅ User authenticated successfully');
    
    // Add user info to header
    const headerContent = document.querySelector('.header-content');
    if (headerContent) {
        const me = JSON.parse(localStorage.getItem('me') || '{}');
        const profile = me.profile || {};
        const userName = profile.firstName && profile.lastName 
            ? `${profile.firstName} ${profile.lastName}`
            : profile.email || 'User';
        
        const userInfo = document.createElement('div');
        userInfo.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; gap: 4px;';
        userInfo.innerHTML = `
            <span style="color: white; font-size: 14px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${userName}</span>
            <span 
                onclick="window.prolibu.logout()" 
                style="color: rgba(255,255,255,0.7); cursor: pointer; font-size: 12px; text-decoration: underline;"
            >
                Logout
            </span>
        `;
        headerContent.appendChild(userInfo);
    }
    
    // Add interactive functionality
    const features = document.querySelectorAll('.feature');
    features.forEach((feature, index) => {
        feature.addEventListener('click', () => {
            console.log(`Feature ${index + 1} clicked:`, feature.querySelector('.feature-title').textContent);
        });
    });
}

// Logout function
function logout() {
    clearAuthAndShowLogin();
}

// Initialize app
async function init() {
    const isAuthenticated = await validateAuth();
    
    if (isAuthenticated) {
        showMainContent();
    }
}

// Make functions available globally
window.prolibu = {
    fetchAPI,
    logout
};

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

console.log('🔧 Prolibu utilities loaded');
