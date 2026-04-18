// Top bar is now permanently visible — auto-hide behaviour removed.
// The pull-down indicator is hidden too since there's nothing to pull.
const createToolbar = () => {
	const tool = document.getElementById('bar')
	const pull = document.getElementById('bar-pull')
	if (tool) {
		tool.style.top = ''
		tool.classList.add('open')
	}
	if (pull) pull.style.display = 'none'
}

export default createToolbar
