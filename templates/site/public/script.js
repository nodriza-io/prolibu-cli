/* eslint-env browser */

// Welcome message
console.log('🚀 Prolibu Site loaded successfully!');
console.log('📝 Edit the files in public/ to customize your site:');
console.log('   - index.html: Main HTML structure');
console.log('   - styles.css: Styling and design');
console.log('   - script.js: JavaScript functionality');

// Example: Add interactive functionality
document.addEventListener('DOMContentLoaded', () => {
    // Log when the page is fully loaded
    console.log('✅ DOM fully loaded and parsed');
    
    // Example: Add click handlers to feature cards
    const features = document.querySelectorAll('.feature');
    features.forEach((feature, index) => {
        feature.addEventListener('click', () => {
            console.log(`Feature ${index + 1} clicked:`, feature.querySelector('.feature-title').textContent);
        });
    });
    
    // Example: Add hover effect feedback
    const fileItems = document.querySelectorAll('.file-item');
    fileItems.forEach(item => {
        item.addEventListener('mouseenter', () => {
            console.log('📄 Hovering over:', item.querySelector('strong').textContent);
        });
    });
});

// Example: Utility function for API calls
async function fetchAPI(endpoint, options = {}) {
    try {
        const apiKey = localStorage.getItem('apiKey');
        const domain = window.location.hostname;
        
        const response = await fetch(`https://${domain}/v2/${endpoint}`, {
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

// Example: Check if user is authenticated
function checkAuth() {
    const apiKey = localStorage.getItem('apiKey');
    return !!apiKey;
}

// Example: Logout function
function logout() {
    localStorage.removeItem('apiKey');
    localStorage.removeItem('me');
    window.location.reload();
}

// Make functions available globally if needed
window.prolibu = {
    fetchAPI,
    checkAuth,
    logout
};

console.log('🔧 Prolibu utilities loaded. Access via window.prolibu');
