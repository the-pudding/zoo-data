
// process.env.DEBUG='pw:api'

const { firefox } = require('playwright');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const {createWriteStream, readdir} = require('fs')
const fs = require('fs')
const {promisify} = require('util')
const path = require('path')
const knox = require('knox')
const d3 = require('d3-dsv')

const dataName = 'gifs.json'
const data = []

const filePathImages = 'zoo-cams/temp'
const filePathGIF = 'zoo-cam/output'
const frameCount = 5

let videoDimensions = {
	width: 0,
	height: 0
}

const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

const client = knox.createClient({
	key: AWS_KEY,
	secret: AWS_KEY_SECRET,
	bucket: AWS_BUCKET
})


let page = null

const extension = '.png'

const readdirAsync = promisify(readdir)

const imagesFolder = `${__dirname}/temp`


async function createGif(algorithm, id) {
	return new Promise(async resolve1 => {
		// const theseImages = client.get(`${filePathImages}/${id}`)
		// const theseImages = `${imagesFolder}/${id}`
	
		// const files = (await readdirAsync(theseImages))
		// 	.filter(file => path.extname(file).toLowerCase() === extension)
		// 	.map(d => `${d.substr(0, d.length - 4)}`)
		// 	.sort((a, b) => a - b)
		// 	.map(d => `${d.substr(0, d.length)}.png`)

		//  there will always be the same range of image number files
		// so just iterate and create an array of numbers
		const imageRange = [...Array(frameCount).keys()] 
  
		const [width, height] = await new Promise((resolve2, reject2) => {

			// get the file and metadata from s3 without loading it
			client.getFile(`${filePathImages}/${id}/0.png`, (err, res) => {
				resolve2([res.headers['x-amz-meta-width'], res.headers['x-amz-meta-height']])
			})

		})
		console.log({width, height, imageRange})
		const canvasWidth = 500
		const canvasHeight = 281
		
	// 	const dstPath = `${__dirname}/output/${id}.gif`
  
	// 	const writeStream = createWriteStream(dstPath)
  
	// 	writeStream.on('close', () => {
	// 		resolve1()
	// 	})
  
	// 	const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)
  
	// 	encoder.createReadStream().pipe(writeStream)
	// 	encoder.start()
	// 	encoder.setDelay(200)
  
	// 	const canvas = createCanvas(canvasWidth, canvasHeight)
	// 	const ctx = canvas.getContext('2d')
        
  
	// 	for (const file of files) {
	// 		await new Promise(resolve3 => {
	// 			const image = new Image()
	// 			image.onload = () => {
	// 				ctx.drawImage(image, 0, 0, width, height, // source dimensions
	// 					0, 0, canvasWidth, canvasHeight)
	// 				encoder.addFrame(ctx)
	// 				resolve3()
	// 			}
				
	// 			image.src = `${imagesFolder}/${id}/${file}`
	// 		})
	// 	}
	})
}


async function collectData(cam){
	const timestamp = Date.now()
	cam.timestamp = timestamp

	const string = JSON.stringify(cam)

	data.push(string)
}

function timeout(ms){
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function screenshot(cam) {
	const {url, id, play} = cam

	// set working directory
	const workDir = `./temp/${id}`

	// check for working directory
	if (!fs.existsSync(workDir)) fs.mkdirSync(workDir)


	// navigate to URL
	await page.goto(url).catch((e) => {console.error(e)})

	// if there's a play button, click it
	if (play) {
		const buttons = play.split(', ')
		buttons.forEach(async d => {
			await page.click(`${d}`).catch((e) => console.error(e))
		})
	}

	// wait for video
	await page.waitForSelector('video').catch((e) => {console.error(e)})

	const element = await page.$('video').catch((e) => {console.error(e)})

	if (element){
		// after video has loaded, then record data
		await collectData(cam) 

		
		await timeout(5000)
		// find out if video is paused
		let paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(e)})

		// if it's still paused, click the page and wait 10 seconds before checking again
		if (paused === true) {
			await page.click('body').catch((e) => {console.error(e)})	
			await timeout(10000)
		}

		// check again
		paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(e)})
		
		
		// if video is playing, start taking screenshots
		// otherwise move on to the next video
		if (paused !== true ){
			
			// take 60 screenshots 
			for (let count = 0; count < frameCount; count++){
				// take a screenshot
				const ss = await element.screenshot({path: ''}).catch((e) => {
					console.error(e); 
					return('') })

				// measure video dimensions only on first screenshot
				if (count === 0){
					videoDimensions = await element.evaluate(() => ({
						width: document.documentElement.clientWidth,
						height: document.documentElement.clientHeight
					}))
        
				}
				// console.log(ss)

				// write screenshot to AWS
				const req = client.put(`${filePathImages}/${id}/${count}.png`, {
					'Content-Type': 'image/png',
					'x-amz-meta-height': videoDimensions.height,
					'x-amz-meta-width': videoDimensions.width
				})
                
				req.on('response', (res) => {
					if (res.statusCode === 200){
						console.log('saved to %s', req.url)
					}
				})
				req.end(ss)

				// if on last one 
				if (count === frameCount - 1) {
					 // createGif('neuquant', id)
				}
			}
		}
	}
}

async function writeData(){
	fs.writeFile(dataName, data, err => {
		if (err) return console.error('File write error:', err)
	})
}

async function getZoos(){
	const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))
	const sample = webcams.slice(75, 77)

	// launch a single browser
	const browser = await firefox.launch({headless: true,  args: ['--no-sandbox'] })

	// launch a single page 
	page = await browser.newPage()
	// set a timeout for the page of 10 seconds
	page.setDefaultTimeout(10000)

	// navigate to each page one at a time
	for (const cam of sample){
		await screenshot(cam)
	}

	// when done, close the browser
	await browser.close()
	await writeData()

}

// run the script
// getZoos()
createGif('neuquant', 84)